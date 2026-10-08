import { useCallback, useEffect, useState } from 'react';
import { getRecent, type RecentUpload } from '../api';
import { QrDialog } from './QrDialog';
import { Card, ErrorAlert } from './ui';

interface Props {
  /** Change this value to reload the list (e.g. after an upload finishes). */
  refreshKey: number;
  onSessionExpired: () => void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function RecentUploads({ refreshKey, onSessionExpired }: Props) {
  const [items, setItems] = useState<RecentUpload[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState<RecentUpload | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { items } = await getRecent();
      setItems(items);
      setError(null);
    } catch (err) {
      if ((err as { status?: number }).status === 401) onSessionExpired();
      else setError(err instanceof Error ? err.message : 'Could not load recent uploads.');
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <Card>
      <section aria-labelledby="recent-heading" aria-busy={loading}>
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 id="recent-heading" className="text-lg font-semibold">
            Recent uploads
          </h2>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md px-2 py-1 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-60 dark:text-indigo-300 dark:hover:bg-slate-800"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {error && <ErrorAlert>{error}</ErrorAlert>}

        {items === null && !error ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">Loading…</p>
        ) : items?.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">No uploads yet. Files you upload will appear here.</p>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {items?.map((item) => (
              <li key={item.slug} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <a
                    href={item.driveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative block truncate font-medium text-slate-900 underline-offset-2 hover:underline dark:text-slate-100"
                    title={item.fileName}
                  >
                    {item.fileName}
                    <span className="sr-only"> (opens in Google Drive in a new tab)</span>
                  </a>
                  <p className="truncate text-sm text-slate-600 dark:text-slate-400">
                    <time dateTime={item.createdAt}>{dateFormat.format(new Date(item.createdAt))}</time>
                    {' · '}
                    <span className="font-mono">/f/{item.slug}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <p className="rounded-full bg-slate-100 px-3 py-1 text-sm font-semibold tabular-nums text-slate-800 dark:bg-slate-800 dark:text-slate-100">
                    {item.scanCount} {item.scanCount === 1 ? 'scan' : 'scans'}
                  </p>
                  <button
                    type="button"
                    onClick={() => setViewing(item)}
                    className="relative inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-800 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-100 dark:hover:bg-slate-800"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2v2h-2zM18 14h2v2h-2z" strokeLinejoin="round" />
                    </svg>
                    View QR
                    <span className="sr-only"> for {item.fileName}</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {viewing && <QrDialog item={viewing} onClose={() => setViewing(null)} />}
    </Card>
  );
}
