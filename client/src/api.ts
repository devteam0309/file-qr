export interface Session {
  authenticated: boolean;
  maxUploadMb: number;
}

export interface UploadResult {
  fileId: string;
  name: string;
  size: number;
  /** Google Drive link. */
  link: string;
  slug: string;
  /** {PUBLIC_BASE_URL}/f/{slug}: what the QR code encodes. Redirects to `link` and counts the scan. */
  shortUrl: string;
}

export interface RecentUpload {
  slug: string;
  shortUrl: string;
  driveUrl: string;
  fileName: string;
  createdAt: string;
  scanCount: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function errorMessage(body: unknown, status: number): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' ? message : `Request failed (HTTP ${status}).`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Is it running?');
  }
  const body = parseJson(await res.text());
  if (!res.ok) throw new ApiError(res.status, errorMessage(body, res.status));
  return body as T;
}

export const getSession = () => request<Session>('/api/session');

export const login = (password: string) =>
  request<{ ok: true }>('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

export const getRecent = () => request<{ items: RecentUpload[] }>('/api/recent');

export const logout = () => request<{ ok: true }>('/api/logout', { method: 'POST' });

export interface UploadCallbacks {
  /** 0..1 while bytes are being sent to our server. */
  onProgress: (fraction: number) => void;
  /** All bytes sent; the server is now saving to Google Drive. */
  onUploaded: () => void;
}

/** Uses XMLHttpRequest because fetch can't report upload progress. */
export function uploadFile(file: File, { onProgress, onUploaded }: UploadCallbacks): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.upload.onload = () => onUploaded();

    xhr.onload = () => {
      const body = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body as UploadResult);
      else reject(new ApiError(xhr.status, errorMessage(body, xhr.status)));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error. The upload did not finish.'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled.'));

    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
