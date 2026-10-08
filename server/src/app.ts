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

export interface AppDeps {
  drive: DriveService;
  /** Where multer writes uploads before they're streamed to Drive. */
  tempDir?: string;
  /** Built client to serve (production). Skipped if the folder doesn't exist. */
  clientDistDir?: string;
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

  const upload = multer({
    storage: multer.diskStorage({ destination: tempDir }),
    limits: { fileSize: Math.floor(config.MAX_UPLOAD_MB * 1024 * 1024), files: 1 },
    defParamCharset: 'utf8',
  });

  const api = express.Router();
  api.use(express.json({ limit: '10kb' }));

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
      res.json({ fileId: result.fileId, name: file.originalname, size: file.size, link: result.link });
    },
  );

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));
  app.use('/api', api);

  if (deps.clientDistDir && fs.existsSync(path.join(deps.clientDistDir, 'index.html'))) {
    app.use(express.static(deps.clientDistDir, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(deps.clientDistDir!, 'index.html'));
    });
  }

  app.use(errorHandler(config.MAX_UPLOAD_MB));
  return app;
}
