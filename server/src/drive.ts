import fs from 'node:fs';
import { google, type drive_v3 } from 'googleapis';
import type { Config } from './config.js';
import { googleStatus, isInvalidGrant } from './errors.js';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** appProperties tag on our folder, so we can find it again even if it's renamed. */
const FOLDER_TAG_KEY = 'fileQrApp';
const FOLDER_TAG_VALUE = 'uploadsFolder';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function createDriveClient(config: Config): drive_v3.Drive {
  const auth = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth });
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err: unknown): boolean {
  if (isInvalidGrant(err)) return false;
  const status = googleStatus(err);
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

/**
 * Run a Drive call, retrying 429 and 5xx responses up to `retries` times with exponential
 * backoff (plus jitter). `fn` is called fresh on each attempt so streams can be re-created.
 */
export async function withRetry<T>(fn: () => Promise<T>, { retries = 3, baseDelayMs = 500 }: RetryOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
      console.warn(`[drive] ${googleStatus(err)} response, retrying in ${Math.round(delay)} ms (attempt ${attempt + 1}/${retries})`);
      await sleep(delay);
    }
  }
}

export interface UploadInput {
  path: string;
  name: string;
  mimeType: string;
}

export interface UploadResult {
  fileId: string;
  link: string;
}

export class DriveService {
  private folderId: Promise<string> | null = null;

  constructor(
    private readonly drive: drive_v3.Drive,
    private readonly folderName: string,
    private readonly retry: RetryOptions = {},
  ) {}

  /**
   * With the drive.file scope the app can only write into folders it created itself,
   * so find (by appProperties tag) or create our own folder. The id is cached; the
   * promise is cached too so concurrent first uploads don't create two folders.
   */
  getFolderId(): Promise<string> {
    if (!this.folderId) {
      this.folderId = this.findOrCreateFolder().catch((err) => {
        this.folderId = null;
        throw err;
      });
    }
    return this.folderId;
  }

  private async findOrCreateFolder(): Promise<string> {
    const list = await withRetry(
      () =>
        this.drive.files.list({
          q:
            `mimeType = '${FOLDER_MIME}' and trashed = false and ` +
            `appProperties has { key='${FOLDER_TAG_KEY}' and value='${FOLDER_TAG_VALUE}' }`,
          spaces: 'drive',
          fields: 'files(id, name)',
          pageSize: 1,
        }),
      this.retry,
    );
    const existing = list.data.files?.[0]?.id;
    if (existing) return existing;

    const created = await withRetry(
      () =>
        this.drive.files.create({
          requestBody: {
            name: this.folderName,
            mimeType: FOLDER_MIME,
            appProperties: { [FOLDER_TAG_KEY]: FOLDER_TAG_VALUE },
          },
          fields: 'id',
        }),
      this.retry,
    );
    if (!created.data.id) throw new Error('Drive did not return an id for the new folder.');
    console.log(`[drive] Created folder "${this.folderName}" (${created.data.id})`);
    return created.data.id;
  }

  async delete(fileId: string): Promise<void> {
    await withRetry(() => this.drive.files.delete({ fileId }), this.retry);
  }

  async upload(input: UploadInput): Promise<UploadResult> {
    let folderId = await this.getFolderId();

    const createFile = (parent: string) =>
      withRetry(async () => {
        // Fresh stream per attempt; always closed so the temp file can be deleted (matters on Windows).
        const body = fs.createReadStream(input.path);
        try {
          return await this.drive.files.create({
            requestBody: { name: input.name, parents: [parent] },
            media: { mimeType: input.mimeType, body },
            fields: 'id, webViewLink',
          });
        } finally {
          body.destroy();
        }
      }, this.retry);

    let created;
    try {
      created = await createFile(folderId);
    } catch (err) {
      // Cached folder was deleted from Drive: forget it and try once more with a fresh one.
      if (googleStatus(err) !== 404) throw err;
      this.folderId = null;
      folderId = await this.getFolderId();
      created = await createFile(folderId);
    }

    const fileId = created.data.id;
    if (!fileId) throw new Error('Drive did not return an id for the uploaded file.');

    try {
      await withRetry(
        () =>
          this.drive.permissions.create({
            fileId,
            requestBody: { type: 'anyone', role: 'reader', allowFileDiscovery: false },
          }),
        this.retry,
      );
    } catch (err) {
      // Don't leave a private, unreachable file behind.
      await withRetry(() => this.drive.files.delete({ fileId }), this.retry).catch((deleteErr) => {
        console.error(`[drive] Failed to delete orphaned file ${fileId} after sharing failed:`, deleteErr);
      });
      throw err;
    }

    return {
      fileId,
      link: created.data.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view`,
    };
  }
}
