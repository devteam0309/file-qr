import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { drive_v3 } from 'googleapis';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { configSchema } from '../src/config.js';
import { DriveService } from '../src/drive.js';

const config = configSchema.parse({
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REFRESH_TOKEN: 'test-refresh-token',
  DRIVE_FOLDER_NAME: 'Test Uploads',
  APP_PASSWORD: 'correct horse battery',
  SESSION_SECRET: 'x'.repeat(48),
  MAX_UPLOAD_MB: '1',
});

/** Shape of a googleapis (gaxios) HTTP error. */
function googleError(status: number, data: unknown = {}, message = `Request failed with status ${status}`) {
  return Object.assign(new Error(message), { response: { status, data }, config: {} });
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createFakeDrive() {
  const uploaded: { name: string; parents: string[]; mimeType: string; content: Buffer }[] = [];
  const fake = {
    files: {
      list: vi.fn(async () => ({ data: { files: [{ id: 'folder-123', name: 'Test Uploads' }] } })),
      create: vi.fn(async (params: drive_v3.Params$Resource$Files$Create) => {
        if (params.requestBody?.mimeType === 'application/vnd.google-apps.folder') {
          return { data: { id: 'new-folder-456' } };
        }
        const content = await readAll(params.media!.body as Readable);
        uploaded.push({
          name: params.requestBody!.name!,
          parents: params.requestBody!.parents!,
          mimeType: params.media!.mimeType!,
          content,
        });
        return { data: { id: 'file-abc', webViewLink: 'https://drive.google.com/file/d/file-abc/view?usp=drivesdk' } };
      }),
      delete: vi.fn(async () => ({ data: {} })),
    },
    permissions: {
      create: vi.fn(async () => ({ data: { id: 'anyoneWithLink' } })),
    },
  };
  return { fake, uploaded, client: fake as unknown as drive_v3.Drive };
}

let tempDir: string;
let fakeDrive: ReturnType<typeof createFakeDrive>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-qr-test-'));
  fakeDrive = createFakeDrive();
  const drive = new DriveService(fakeDrive.client, config.DRIVE_FOLDER_NAME, { baseDelayMs: 1 });
  app = createApp(config, { drive, tempDir });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function login(): Promise<string> {
  const res = await request(app).post('/api/login').send({ password: config.APP_PASSWORD });
  expect(res.status).toBe(200);
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  return setCookie[0]!.split(';')[0]!;
}

const tempFiles = () => fs.readdirSync(tempDir);

describe('auth', () => {
  it('rejects a wrong password', async () => {
    const res = await request(app).post('/api/login').send({ password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { message: 'Incorrect password.' } });
  });

  it('sets an httpOnly, SameSite=Strict, 12h session cookie', async () => {
    const res = await request(app).post('/api/login').send({ password: config.APP_PASSWORD });
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Max-Age=43200/);
  });

  it('reports session state', async () => {
    expect((await request(app).get('/api/session')).body).toEqual({ authenticated: false, maxUploadMb: 1 });
    const cookie = await login();
    expect((await request(app).get('/api/session').set('Cookie', cookie)).body.authenticated).toBe(true);
  });

  it('blocks uploads without a session', async () => {
    const res = await request(app).post('/api/upload').attach('file', Buffer.from('hi'), 'a.txt');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/Not logged in/);
    expect(fakeDrive.fake.files.create).not.toHaveBeenCalled();
  });

  it('sets security headers (helmet)', async () => {
    const res = await request(app).get('/api/session');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    // must stay off so the app works over plain HTTP on a LAN address
    expect(res.headers['content-security-policy']).not.toMatch(/upgrade-insecure-requests/);
  });
});

describe('POST /api/upload', () => {
  it('streams the file to Drive, shares it, returns the link and removes the temp file', async () => {
    const cookie = await login();
    const res = await request(app)
      .post('/api/upload')
      .set('Cookie', cookie)
      .attach('file', Buffer.from('hello drive'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      fileId: 'file-abc',
      name: 'notes.txt',
      size: 11,
      link: 'https://drive.google.com/file/d/file-abc/view?usp=drivesdk',
    });

    expect(fakeDrive.uploaded).toEqual([
      { name: 'notes.txt', parents: ['folder-123'], mimeType: 'text/plain', content: Buffer.from('hello drive') },
    ]);
    expect(fakeDrive.fake.files.create).toHaveBeenCalledWith(expect.objectContaining({ fields: 'id, webViewLink' }));
    expect(fakeDrive.fake.permissions.create).toHaveBeenCalledWith({
      fileId: 'file-abc',
      requestBody: { type: 'anyone', role: 'reader', allowFileDiscovery: false },
    });
    expect(fakeDrive.fake.files.delete).not.toHaveBeenCalled();
    expect(tempFiles()).toEqual([]);
  });

  it('keeps non-English file names intact (defParamCharset utf8)', async () => {
    const cookie = await login();
    const name = 'résumé 日本語 файл.pdf';
    const res = await request(app)
      .post('/api/upload')
      .set('Cookie', cookie)
      .attach('file', Buffer.from('%PDF'), { filename: name, contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(name);
    expect(fakeDrive.uploaded[0]!.name).toBe(name);
  });

  it('creates a tagged folder when none exists, then caches its id', async () => {
    fakeDrive.fake.files.list.mockResolvedValue({ data: { files: [] } });
    const cookie = await login();

    for (let i = 0; i < 2; i++) {
      const res = await request(app).post('/api/upload').set('Cookie', cookie).attach('file', Buffer.from('x'), 'x.txt');
      expect(res.status).toBe(200);
    }

    expect(fakeDrive.fake.files.list).toHaveBeenCalledTimes(1);
    expect(fakeDrive.fake.files.list.mock.calls[0]).toEqual([
      expect.objectContaining({ q: expect.stringContaining("appProperties has { key='fileQrApp' and value='uploadsFolder' }") }),
    ]);
    expect(fakeDrive.fake.files.create).toHaveBeenCalledWith({
      requestBody: {
        name: 'Test Uploads',
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { fileQrApp: 'uploadsFolder' },
      },
      fields: 'id',
    });
    expect(fakeDrive.uploaded.map((u) => u.parents)).toEqual([['new-folder-456'], ['new-folder-456']]);
  });

  it('deletes the Drive file if sharing fails, and still removes the temp file', async () => {
    fakeDrive.fake.permissions.create.mockRejectedValue(
      googleError(403, { error: { message: 'Sharing is disabled by your administrator.' } }),
    );
    const cookie = await login();
    const res = await request(app).post('/api/upload').set('Cookie', cookie).attach('file', Buffer.from('x'), 'x.txt');

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: { message: 'Google Drive error (403): Sharing is disabled by your administrator.' } });
    expect(fakeDrive.fake.files.delete).toHaveBeenCalledWith({ fileId: 'file-abc' });
    expect(tempFiles()).toEqual([]);
  });

  it('retries 429/5xx responses with backoff and re-streams the file', async () => {
    const realCreate = fakeDrive.fake.files.create.getMockImplementation()!;
    fakeDrive.fake.files.create
      .mockImplementationOnce(async () => {
        throw googleError(429);
      })
      .mockImplementationOnce(async () => {
        throw googleError(503);
      })
      .mockImplementation(realCreate);
    const cookie = await login();
    const res = await request(app).post('/api/upload').set('Cookie', cookie).attach('file', Buffer.from('retry me'), 'r.txt');

    expect(res.status).toBe(200);
    expect(fakeDrive.fake.files.create).toHaveBeenCalledTimes(3);
    expect(fakeDrive.uploaded[0]!.content.toString()).toBe('retry me');
    expect(tempFiles()).toEqual([]);
  });

  it('gives up after 3 retries', async () => {
    fakeDrive.fake.files.create.mockRejectedValue(googleError(500, { error: { message: 'Backend Error' } }));
    const cookie = await login();
    const res = await request(app).post('/api/upload').set('Cookie', cookie).attach('file', Buffer.from('x'), 'x.txt');

    expect(res.status).toBe(502);
    expect(fakeDrive.fake.files.create).toHaveBeenCalledTimes(4); // 1 try + 3 retries
    expect(tempFiles()).toEqual([]);
  });

  it('maps invalid_grant to a re-run auth:init message without retrying', async () => {
    fakeDrive.fake.files.list.mockRejectedValue(
      googleError(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 'invalid_grant'),
    );
    const cookie = await login();
    const res = await request(app).post('/api/upload').set('Cookie', cookie).attach('file', Buffer.from('x'), 'x.txt');

    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/invalid_grant/);
    expect(res.body.error.message).toMatch(/npm run auth:init/);
    expect(fakeDrive.fake.files.list).toHaveBeenCalledTimes(1);
    expect(tempFiles()).toEqual([]);
  });

  it('maps invalid_client to a check-your-credentials message', async () => {
    fakeDrive.fake.files.list.mockRejectedValue(googleError(401, { error: 'invalid_client' }, 'invalid_client'));
    const cookie = await login();
    const res = await request(app).post('/api/upload').set('Cookie', cookie).attach('file', Buffer.from('x'), 'x.txt');

    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
  });

  it('returns 413 for files over MAX_UPLOAD_MB', async () => {
    const cookie = await login();
    const res = await request(app)
      .post('/api/upload')
      .set('Cookie', cookie)
      .attach('file', Buffer.alloc(1024 * 1024 + 1), 'big.bin');

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: { message: 'File is too large. The maximum size is 1 MB.' } });
    expect(fakeDrive.fake.files.create).not.toHaveBeenCalled();
    expect(tempFiles()).toEqual([]);
  });

  it('rate-limits uploads per login session, not per IP', async () => {
    const officeMate1 = await login();
    for (let i = 0; i < 30; i++) {
      await request(app).post('/api/upload').set('Cookie', officeMate1).attach('file', Buffer.from('x'), 'x.txt');
    }
    const limited = await request(app).post('/api/upload').set('Cookie', officeMate1).attach('file', Buffer.from('x'), 'x.txt');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: { message: 'Too many uploads. Try again in a few minutes.' } });

    // Same IP, different session: unaffected.
    await new Promise((r) => setTimeout(r, 1100)); // JWT iat has 1s resolution; ensure a distinct token
    const officeMate2 = await login();
    expect(officeMate2).not.toBe(officeMate1);
    const ok = await request(app).post('/api/upload').set('Cookie', officeMate2).attach('file', Buffer.from('x'), 'x.txt');
    expect(ok.status).toBe(200);
  });

  it('returns 400 when no file is sent', async () => {
    const cookie = await login();
    const res = await request(app).post('/api/upload').set('Cookie', cookie).field('other', 'x');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/field "file"/);
  });
});
