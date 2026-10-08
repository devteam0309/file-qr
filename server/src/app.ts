import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';
import {
  SESSION_COOKIE,
  isAuthenticated,
  passwordMatches,
  requireAuth,
  sessionCookieOptions,
  signSession,
} from './auth.js';
import type { Config } from './config.js';
import type { DriveService } from './drive.js';
import { HttpError, errorHandler } from './errors.js';
import { SLUG_PATTERN, type LinkStore, type ShortLink } from './links.js';

export interface AppDeps {
  drive: DriveService;
  links: LinkStore;
  /** Where multer writes uploads before they're streamed to Drive. */
  tempDir?: string;
  /** Built client to serve (production). Skipped if the folder doesn't exist. */
  clientDistDir?: string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Minimal standalone page for /f/ responses that don't redirect (shown to people scanning a QR code). */
function messagePage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 1rem; box-sizing: border-box;
         font: 16px/1.5 system-ui, sans-serif; background: #f8fafc; color: #0f172a; }
  main { max-width: 26rem; text-align: center; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #475569; }
  @media (prefers-color-scheme: dark) { body { background: #020617; color: #f1f5f9; } p { color: #94a3b8; } }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export function createApp(config: Config, deps: AppDeps) {
  const tempDir = deps.tempDir ?? path.join(os.tmpdir(), 'file-qr-uploads');
  fs.mkdirSync(tempDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(config.TRUST_PROXY));

  app.use(
    helmet({
      // Helmet's default CSP adds upgrade-insecure-requests, which breaks the page when it's
      // served over plain HTTP on a LAN address (e.g. http://192.168.x.x:3001). Behind HTTPS
      // everything is same-origin anyway, so dropping it costs nothing.
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    }),
  );
  app.use(cookieParser());

  const limiterMessage = (message: string) => ({ error: { message } });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: limiterMessage('Too many login attempts. Try again in 15 minutes.'),
  });
  // Runs after requireAuth and counts per login session, not per IP: a whole office
  // shares one public IP, so a per-IP limit would be shared by everyone.
  const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    keyGenerator: (req) => `session:${String(req.cookies?.[SESSION_COOKIE])}`,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: limiterMessage('Too many uploads. Try again in a few minutes.'),
  });

  // Public, unauthenticated: cap scans per IP so nobody can hammer the database.
  const scanLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).type('html').send(messagePage('Too many requests', 'Please wait a minute and scan again.'));
    },
  });

  const upload = multer({
    storage: multer.diskStorage({ destination: tempDir }),
    limits: { fileSize: Math.floor(config.MAX_UPLOAD_MB * 1024 * 1024), files: 1 },
    defParamCharset: 'utf8',
  });

  const api = express.Router();
  api.use(express.json({ limit: '10kb' }));

  const shortUrl = (req: express.Request, slug: string) =>
    `${config.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`}/f/${slug}`;
  const toApiLink = (req: express.Request, link: ShortLink) => ({
    slug: link.slug,
    shortUrl: shortUrl(req, link.slug),
    driveUrl: link.driveUrl,
    fileName: link.fileName,
    createdAt: link.createdAt,
    scanCount: link.scanCount,
  });

  api.get('/session', (req, res) => {
    res.json({ authenticated: isAuthenticated(req, config.SESSION_SECRET), maxUploadMb: config.MAX_UPLOAD_MB });
  });

  api.post('/login', loginLimiter, (req, res) => {
    const password: unknown = req.body?.password;
    if (typeof password !== 'string' || !passwordMatches(password, config.APP_PASSWORD)) {
      throw new HttpError(401, 'Incorrect password.');
    }
    res.cookie(SESSION_COOKIE, signSession(config.SESSION_SECRET), sessionCookieOptions(req));
    res.json({ ok: true });
  });

  api.post('/logout', (req, res) => {
    const { maxAge: _maxAge, ...options } = sessionCookieOptions(req);
    res.clearCookie(SESSION_COOKIE, options);
    res.json({ ok: true });
  });

  api.post(
    '/upload',
    requireAuth(config.SESSION_SECRET),
    uploadLimiter,
    upload.single('file'),
    async (req, res) => {
      const file = req.file;
      if (!file) throw new HttpError(400, 'No file received. Send it in the multipart field "file".');
      let result;
      try {
        result = await deps.drive.upload({
          path: file.path,
          name: file.originalname,
          mimeType: file.mimetype || 'application/octet-stream',
        });
      } finally {
        await fs.promises.rm(file.path, { force: true, maxRetries: 3 }).catch((err) => {
          console.error(`[upload] Failed to delete temp file ${file.path}:`, err);
        });
      }

      let link: ShortLink;
      try {
        link = await deps.links.create({ driveFileId: result.fileId, driveUrl: result.link, fileName: file.originalname });
      } catch (err) {
        // Without a short link the QR code can't be made; don't leave the Drive file behind.
        await deps.drive.delete(result.fileId).catch((deleteErr) => {
          console.error(`[upload] Failed to delete Drive file ${result.fileId} after saving its short link failed:`, deleteErr);
        });
        console.error('[upload] Saving short link failed:', err instanceof Error ? (err.stack ?? err.message) : err);
        throw new HttpError(503, 'Could not save the short link for this file, so the upload was undone. Please try again.');
      }

      res.json({
        fileId: result.fileId,
        name: file.originalname,
        size: file.size,
        link: result.link,
        slug: link.slug,
        shortUrl: shortUrl(req, link.slug),
      });
    },
  );

  api.get('/recent', requireAuth(config.SESSION_SECRET), async (req, res) => {
    // Hide files that were deleted (or trashed) in Drive. Rows stay in the database, so a file
    // restored from Drive's trash reappears with its scan count, and its QR code works again.
    const [links, existing] = await Promise.all([deps.links.recent(100), deps.drive.listExistingFileIds()]);
    const visible = links.filter((link) => existing.has(link.driveFileId)).slice(0, 20);
    res.json({ items: visible.map((link) => toApiLink(req, link)) });
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));
  app.use('/api', api);

  // Short links printed in QR codes: count the scan, then send the visitor to Drive.
  app.get('/f/:slug', scanLimiter, async (req, res) => {
    const slug = String(req.params.slug);
    res.set('Cache-Control', 'no-store'); // so browsers don't cache the redirect and skip counting
    const notFound = () =>
      res
        .status(404)
        .type('html')
        .send(messagePage('Link not found', 'This QR code or link does not point to a file. Check that it was copied completely.'));

    if (!SLUG_PATTERN.test(slug)) return notFound();
    try {
      // HEAD requests (link checkers, previews) look the link up without counting a scan.
      const link = req.method === 'HEAD' ? await deps.links.find(slug) : await deps.links.recordScan(slug);
      if (!link) return notFound();
      res.redirect(302, link.driveUrl);
    } catch (err) {
      console.error('[scan] Lookup failed:', err instanceof Error ? (err.stack ?? err.message) : err);
      res.status(503).type('html').send(messagePage('Temporarily unavailable', 'Please try again in a moment.'));
    }
  });

  if (deps.clientDistDir && fs.existsSync(path.join(deps.clientDistDir, 'index.html'))) {
    app.use(express.static(deps.clientDistDir, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(deps.clientDistDir!, 'index.html'));
    });
  }

  app.use(errorHandler(config.MAX_UPLOAD_MB));
  return app;
}
