import crypto from 'node:crypto';
import type { CookieOptions, Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'fileqr_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison (hashing first makes the lengths equal). */
export function passwordMatches(given: string, expected: string): boolean {
  return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

export function signSession(secret: string): string {
  return jwt.sign({ sub: 'file-qr' }, secret, { algorithm: 'HS256', expiresIn: SESSION_TTL_SECONDS });
}

export function isAuthenticated(req: Request, secret: string): boolean {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || token === '') return false;
  try {
    jwt.verify(token, secret, { algorithms: ['HS256'] });
    return true;
  } catch {
    return false;
  }
}

export function sessionCookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    // Secure whenever the request arrived over HTTPS (directly, or via a trusted proxy; see TRUST_PROXY).
    secure: req.secure,
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}

export function requireAuth(secret: string): RequestHandler {
  return (req, _res, next) => {
    if (isAuthenticated(req, secret)) return next();
    next(new HttpError(401, 'Not logged in or session expired. Please enter the password again.'));
  };
}
