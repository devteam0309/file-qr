import { useEffect, useRef } from 'react';
import { formatBytes, type UploadResult } from '../api';
import { QrPanel } from './QrPanel';
import { buttonStyles } from './ui';

interface Props {
  result: UploadResult;
  onUploadAnother: () => void;
}

export function ResultCard({ result, onUploadAnother }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

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

      <QrPanel
        fileName={result.name}
        details={formatBytes(result.size)}
        shortUrl={result.shortUrl}
        driveUrl={result.link}
        action={
          <button type="button" onClick={onUploadAnother} className={buttonStyles.primary}>
            Upload another
          </button>
        }
      />
    </div>
  );
}
