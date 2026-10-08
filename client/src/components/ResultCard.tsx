import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { formatBytes, type UploadResult } from '../api';
import { ErrorAlert, buttonStyles } from './ui';

interface Props {
  result: UploadResult;
  onUploadAnother: () => void;
}

function qrFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'file';
  return `${base}-qr.png`;
}

function copyWithTextarea(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('copy command failed');
}

export function ResultCard({ result, onUploadAnother }: Props) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Rendered large so the downloaded PNG prints crisply; displayed scaled down.
    QRCode.toDataURL(result.shortUrl, { errorCorrectionLevel: 'M', margin: 4, width: 1024, color: { dark: '#000000', light: '#ffffff' } })
      .then((url) => !cancelled && setQrDataUrl(url))
      .catch((err: unknown) => !cancelled && setQrError(err instanceof Error ? err.message : 'Could not generate QR code.'));
    return () => {
      cancelled = true;
    };
  }, [result.shortUrl]);

  useEffect(() => {
    if (!copyStatus) return;
    const t = setTimeout(() => setCopyStatus(''), 2500);
    return () => clearTimeout(t);
  }, [copyStatus]);

  async function copyLink() {
    try {
      // navigator.clipboard only exists on HTTPS or localhost; fall back for plain-HTTP LAN use.
      if (navigator.clipboard) await navigator.clipboard.writeText(result.shortUrl);
      else copyWithTextarea(result.shortUrl);
      setCopyStatus('Link copied to clipboard.');
    } catch {
      setCopyStatus('Copy failed. Select the link above and copy it manually.');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
          ✓
        </span>
        <div className="min-w-0">
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold focus:outline-none">
            Saved to Google Drive
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Anyone with the link (or the QR code) can view this file.</p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
        <div className="shrink-0 rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-700">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt={`QR code linking to ${result.name}`} width={208} height={208} className="h-52 w-52" />
          ) : (
            <div className="flex h-52 w-52 items-center justify-center text-sm text-slate-600">{qrError ? 'No QR code' : 'Generating…'}</div>
          )}
        </div>

        <dl className="w-full min-w-0 space-y-3 text-sm">
          <div>
            <dt className="font-medium text-slate-600 dark:text-slate-400">File</dt>
            <dd className="break-words text-base font-semibold">{result.name}</dd>
            <dd className="text-slate-600 dark:text-slate-400">{formatBytes(result.size)}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-600 dark:text-slate-400">Short link</dt>
            <dd>
              <a
                href={result.shortUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-indigo-700 underline underline-offset-2 hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-200"
              >
                {result.shortUrl}
              </a>
            </dd>
          </div>
        </dl>
      </div>

      {qrError && <ErrorAlert>Could not generate the QR code: {qrError}</ErrorAlert>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button type="button" onClick={copyLink} className={buttonStyles.secondary}>
          Copy link
        </button>
        {qrDataUrl ? (
          <a href={qrDataUrl} download={qrFileName(result.name)} className={buttonStyles.secondary}>
            Download QR (PNG)
          </a>
        ) : (
          <button type="button" disabled className={buttonStyles.secondary}>
            Download QR (PNG)
          </button>
        )}
        <a href={result.link} target="_blank" rel="noopener noreferrer" className={buttonStyles.secondary}>
          Open in Drive
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        <button type="button" onClick={onUploadAnother} className={buttonStyles.primary}>
          Upload another
        </button>
      </div>

      <p role="status" aria-live="polite" className="min-h-5 text-center text-sm text-slate-700 dark:text-slate-300">
        {copyStatus}
      </p>
    </div>
  );
}
