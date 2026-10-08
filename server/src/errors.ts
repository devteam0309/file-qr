import type { ErrorRequestHandler } from 'express';
import multer from 'multer';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** HTTP status from a googleapis (gaxios) error, if it has one. */
export function googleStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const candidate of [e.response?.status, e.status, e.code]) {
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

/** OAuth error code from Google's token endpoint (e.g. "invalid_grant", "invalid_client"), if any. */
function oauthErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { message?: unknown; response?: { data?: { error?: unknown } } };
  const code = e.response?.data?.error;
  if (typeof code === 'string') return code;
  const match = typeof e.message === 'string' ? /^(invalid_grant|invalid_client|unauthorized_client)\b/.exec(e.message) : null;
  return match?.[1];
}

/** True when Google rejected the refresh token (revoked, expired, or from a "Testing" consent screen after 7 days). */
export function isInvalidGrant(err: unknown): boolean {
  return oauthErrorCode(err) === 'invalid_grant';
}

function googleMessage(err: unknown): string {
  const e = err as { response?: { data?: { error?: { message?: unknown } } }; message?: unknown };
  const detail = e.response?.data?.error?.message;
  if (typeof detail === 'string') return detail;
  return typeof e.message === 'string' ? e.message : 'Unknown error';
}

function toHttpError(err: unknown, maxUploadMb: number): HttpError {
  if (err instanceof HttpError) return err;

  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return new HttpError(413, `File is too large. The maximum size is ${maxUploadMb} MB.`);
      case 'LIMIT_UNEXPECTED_FILE':
        return new HttpError(400, 'Unexpected upload field. Send the file in the multipart field "file".');
      default:
        return new HttpError(400, `Upload error: ${err.message}`);
    }
  }

  if (isInvalidGrant(err)) {
    return new HttpError(
      502,
      'Google rejected the stored refresh token (invalid_grant). It was revoked or has expired. ' +
        'Run `npm run auth:init` again and update GOOGLE_REFRESH_TOKEN in .env, then restart the server.',
    );
  }

  const oauthCode = oauthErrorCode(err);
  if (oauthCode === 'invalid_client' || oauthCode === 'unauthorized_client') {
    return new HttpError(
      502,
      `Google rejected the OAuth client (${oauthCode}). Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env. ` +
        'If you changed the client, run `npm run auth:init` again to get a matching refresh token.',
    );
  }

  const status = googleStatus(err);
  const isGoogleError =
    typeof err === 'object' && err !== null && ('response' in err || 'config' in err) && status !== undefined;
  if (isGoogleError) {
    return new HttpError(502, `Google Drive error (${status}): ${googleMessage(err)}`);
  }

  // body-parser / express errors carry a client-facing status
  const maybe = err as { status?: unknown; expose?: unknown; message?: unknown };
  if (typeof maybe.status === 'number' && maybe.status >= 400 && maybe.status < 500 && maybe.expose) {
    return new HttpError(maybe.status, String(maybe.message));
  }

  return new HttpError(500, 'Internal server error.');
}

export function errorHandler(maxUploadMb: number): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    const httpError = toHttpError(err, maxUploadMb);
    if (httpError.status >= 500) {
      // Stack only: Google errors carry the full request config, which shouldn't end up in logs.
      console.error('[error]', err instanceof Error ? (err.stack ?? err.message) : err);
    }
    if (res.headersSent) return;
    res.status(httpError.status).json({ error: { message: httpError.message } });
  };
}
