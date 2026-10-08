import { useEffect, useRef, type MouseEvent } from 'react';
import type { RecentUpload } from '../api';
import { QrPanel } from './QrPanel';
import { buttonStyles } from './ui';

interface Props {
  item: RecentUpload;
  onClose: () => void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Modal QR view for a past upload. Uses the native <dialog>: focus is trapped inside,
 * Esc closes it, and focus returns to the button that opened it.
 */
export function QrDialog({ item, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    // Guarded rather than closed in a cleanup: under StrictMode a cleanup close() would
    // fire "close" and unmount the dialog right after it opened.
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const close = () => dialogRef.current?.close(); // fires "close", which calls onClose

  // Click on the dimmed backdrop (outside the panel) closes the dialog.
  const handleClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) close();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="qr-dialog-title"
      onClose={onClose}
      onClick={handleClick}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/70 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="space-y-6 p-6 sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <h2 id="qr-dialog-title" className="text-xl font-semibold">
            QR code
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="-m-1 rounded-md p-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <QrPanel
          fileName={item.fileName}
          details={
            <>
              Uploaded <time dateTime={item.createdAt}>{dateFormat.format(new Date(item.createdAt))}</time>
              {' · '}
              {item.scanCount} {item.scanCount === 1 ? 'scan' : 'scans'}
            </>
          }
          shortUrl={item.shortUrl}
          driveUrl={item.driveUrl}
          action={
            <button type="button" onClick={close} className={buttonStyles.primary}>
              Close
            </button>
          }
        />
      </div>
    </dialog>
  );
}
