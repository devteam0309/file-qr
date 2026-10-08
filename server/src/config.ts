import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root: works from both server/src (tsx) and server/dist (compiled). */
export const repoRoot = path.resolve(here, '..', '..');
export const envFilePath = path.join(repoRoot, '.env');

let envLoaded = false;
function loadEnvFile(): void {
  if (envLoaded) return;
  envLoaded = true;
  dotenv.config({ path: envFilePath, quiet: true });
}

// Treat empty strings ("FOO=" in .env) the same as missing.
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const requiredString = z.preprocess(blankToUndefined, z.string());

export const googleClientSchema = z.object({
  GOOGLE_CLIENT_ID: requiredString,
  GOOGLE_CLIENT_SECRET: requiredString,
});

export const configSchema = googleClientSchema.extend({
  GOOGLE_REFRESH_TOKEN: requiredString,
  DRIVE_FOLDER_NAME: z.preprocess(blankToUndefined, z.string().default('File QR Uploads')),
  APP_PASSWORD: z.preprocess(blankToUndefined, z.string().min(8, 'must be at least 8 characters')),
  SESSION_SECRET: z.preprocess(
    blankToUndefined,
    z.string().min(32, 'must be at least 32 characters (generate one with the command in the README)'),
  ),
  MAX_UPLOAD_MB: z.preprocess(blankToUndefined, z.coerce.number({ error: 'must be a number' }).positive().max(5000).default(50)),
  PORT: z.preprocess(blankToUndefined, z.coerce.number({ error: 'must be a number' }).int().min(1).max(65535).default(3001)),
  /** Optional: set to 1 (or a hop count / subnet) when running behind a reverse proxy. */
  TRUST_PROXY: z.preprocess(blankToUndefined, z.string().optional()),
  /**
   * Base URL that QR codes point at ({PUBLIC_BASE_URL}/f/{slug}). Printed codes depend on it,
   * so set it in production. If unset, it's taken from each request (fine for local dev).
   */
  PUBLIC_BASE_URL: z.preprocess(
    blankToUndefined,
    z
      .url({ protocol: /^https?$/, error: 'must be a full http(s) URL, e.g. https://file-qr.onrender.com' })
      .transform((url) => url.replace(/\/+$/, ''))
      .optional(),
  ),
  /** Turso (hosted SQLite) database for short links. Unset = local SQLite file in server/data/. */
  TURSO_DATABASE_URL: z.preprocess(blankToUndefined, z.string().optional()),
  TURSO_AUTH_TOKEN: z.preprocess(blankToUndefined, z.string().optional()),
  /** Set to "true" by Render itself. */
  RENDER: z.preprocess(blankToUndefined, z.string().optional()),
}).superRefine((env, ctx) => {
  // Render's disk is wiped on every deploy/restart: a local SQLite file there would silently
  // lose every short link and break printed QR codes. Refuse to start instead.
  if (env.RENDER === 'true' && !env.TURSO_DATABASE_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['TURSO_DATABASE_URL'],
      message: "is required on Render (its disk is wiped on every deploy, which would break every short link). See README → Turso.",
    });
  }
  if (env.TURSO_DATABASE_URL?.startsWith('libsql://') && !env.TURSO_AUTH_TOKEN) {
    ctx.addIssue({ code: 'custom', path: ['TURSO_AUTH_TOKEN'], message: 'is required when TURSO_DATABASE_URL is a libsql:// URL' });
  }
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

function parseWith<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const key = String(issue.path[0] ?? '(root)');
    const raw = env[key];
    const missing = (raw === undefined || raw.trim() === '') && issue.code === 'invalid_type';
    const reason = missing ? 'is missing' : issue.message;
    return `  - ${key} ${reason}`;
  });
  throw new ConfigError(
    `Invalid configuration in ${envFilePath}:\n${lines.join('\n')}\n\n` +
      'Copy .env.example to .env at the repo root and fill in the values (see README).',
  );
}

/** Full app config. Throws ConfigError with a readable list of every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadEnvFile();
  return parseWith(configSchema, env);
}

/** Just the OAuth client credentials (used by `npm run auth:init`, before a refresh token exists). */
export function loadGoogleClientConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env === process.env) loadEnvFile();
  return parseWith(googleClientSchema, env);
}
