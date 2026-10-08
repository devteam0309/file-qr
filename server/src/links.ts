import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type Client, type Row } from '@libsql/client';
import type { Config } from './config.js';

export interface ShortLink {
  slug: string;
  driveFileId: string;
  driveUrl: string;
  fileName: string;
  createdAt: string;
  scanCount: number;
}

// No look-alikes (0/O, 1/l/I) in case someone types a link off a printout. 56^8 ≈ 9.7e13 combinations.
const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SLUG_LENGTH = 8;
export const SLUG_PATTERN = new RegExp(`^[${SLUG_ALPHABET}]{${SLUG_LENGTH}}$`);

export function generateSlug(): string {
  let slug = '';
  for (let i = 0; i < SLUG_LENGTH; i++) slug += SLUG_ALPHABET[crypto.randomInt(SLUG_ALPHABET.length)];
  return slug;
}

/** Turso when configured; otherwise a local SQLite file (development only, see config.ts). */
export function createDbClient(config: Config, localDbPath: string): Client {
  if (config.TURSO_DATABASE_URL) {
    return createClient({ url: config.TURSO_DATABASE_URL, authToken: config.TURSO_AUTH_TOKEN });
  }
  fs.mkdirSync(path.dirname(localDbPath), { recursive: true });
  return createClient({ url: pathToFileURL(localDbPath).href });
}

function toShortLink(row: Row): ShortLink {
  return {
    slug: String(row.slug),
    driveFileId: String(row.drive_file_id),
    driveUrl: String(row.drive_url),
    fileName: String(row.file_name),
    createdAt: String(row.created_at),
    scanCount: Number(row.scan_count),
  };
}

const COLUMNS = 'slug, drive_file_id, drive_url, file_name, created_at, scan_count';

export class LinkStore {
  constructor(
    private readonly db: Client,
    private readonly newSlug: () => string = generateSlug,
  ) {}

  async init(): Promise<void> {
    await this.db.batch(
      [
        `CREATE TABLE IF NOT EXISTS links (
          slug          TEXT PRIMARY KEY,
          drive_file_id TEXT NOT NULL,
          drive_url     TEXT NOT NULL,
          file_name     TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          scan_count    INTEGER NOT NULL DEFAULT 0
        )`,
        'CREATE INDEX IF NOT EXISTS links_created_at ON links (created_at DESC)',
      ],
      'write',
    );
  }

  async create(input: { driveFileId: string; driveUrl: string; fileName: string }): Promise<ShortLink> {
    const createdAt = new Date().toISOString();
    for (let attempt = 1; ; attempt++) {
      const slug = this.newSlug();
      try {
        await this.db.execute({
          sql: 'INSERT INTO links (slug, drive_file_id, drive_url, file_name, created_at) VALUES (?, ?, ?, ?, ?)',
          args: [slug, input.driveFileId, input.driveUrl, input.fileName, createdAt],
        });
        return { slug, ...input, createdAt, scanCount: 0 };
      } catch (err) {
        // Slug collision is astronomically unlikely, but retry rather than fail if it happens.
        const isCollision = (err as { code?: string }).code === 'SQLITE_CONSTRAINT';
        if (!isCollision || attempt >= 5) throw err;
      }
    }
  }

  async find(slug: string): Promise<ShortLink | null> {
    const result = await this.db.execute({ sql: `SELECT ${COLUMNS} FROM links WHERE slug = ?`, args: [slug] });
    const row = result.rows[0];
    return row ? toShortLink(row) : null;
  }

  /** Atomically counts a scan and returns the link, or null for an unknown slug. */
  async recordScan(slug: string): Promise<ShortLink | null> {
    const result = await this.db.execute({
      sql: `UPDATE links SET scan_count = scan_count + 1 WHERE slug = ? RETURNING ${COLUMNS}`,
      args: [slug],
    });
    const row = result.rows[0];
    return row ? toShortLink(row) : null;
  }

  async recent(limit = 20): Promise<ShortLink[]> {
    const result = await this.db.execute({
      sql: `SELECT ${COLUMNS} FROM links ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      args: [limit],
    });
    return result.rows.map(toShortLink);
  }
}
