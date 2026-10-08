import { useEffect, useRef, useState } from 'react';
import { ApiError, formatBytes, getSession, logout, uploadFile, type Session, type UploadResult } from './api';
import { LoginScreen } from './components/LoginScreen';
import { ResultCard } from './components/ResultCard';
import { UploadZone } from './components/UploadZone';
import { Card, ErrorAlert } from './components/ui';

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; file: File; progress: number }
  | { kind: 'saving'; file: File }
  | { kind: 'done'; result: UploadResult };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const chooseButtonRef = useRef<HTMLButtonElement>(null);

  async function refreshSession() {
    try {
      setSession(await getSession());
      setSessionError(null);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Could not reach the server.');
    }
  }

  useEffect(() => {
    void refreshSession();
  }, []);

  async function handleFile(file: File) {
    if (!session) return;
    setError(null);
    if (file.size > session.maxUploadMb * 1024 * 1024) {
      setError(`"${file.name}" is ${formatBytes(file.size)}. The maximum size is ${session.maxUploadMb} MB.`);
      return;
    }

    setPhase({ kind: 'uploading', file, progress: 0 });
    try {
      const result = await uploadFile(file, {
        onProgress: (progress) => setPhase({ kind: 'uploading', file, progress }),
        onUploaded: () => setPhase({ kind: 'saving', file }),
      });
      setPhase({ kind: 'done', result });
    } catch (err) {
      setPhase({ kind: 'idle' });
      if (err instanceof ApiError && err.status === 401) {
        setLoginNotice('Your session expired. Log in again, then re-upload the file.');
        setSession({ ...session, authenticated: false });
        return;
      }
      setError(err instanceof Error ? err.message : 'Upload failed.');
    }
  }

  function uploadAnother() {
    setError(null);
    setPhase({ kind: 'idle' });
    requestAnimationFrame(() => chooseButtonRef.current?.focus());
  }

  async function handleLogout() {
    await logout().catch(() => {});
    setPhase({ kind: 'idle' });
    setError(null);
    setLoginNotice(null);
    await refreshSession();
  }

  let content;
  if (sessionError) {
    content = (
      <Card>
        <ErrorAlert>{sessionError}</ErrorAlert>
      </Card>
    );
  } else if (!session) {
    content = <p className="text-center text-slate-600 dark:text-slate-400">Loading…</p>;
  } else if (!session.authenticated) {
    content = (
      <LoginScreen
        notice={loginNotice}
        onLoggedIn={() => {
          setLoginNotice(null);
          void refreshSession();
        }}
      />
    );
  } else {
    content = (
      <Card>
        {phase.kind === 'done' ? (
          <ResultCard result={phase.result} onUploadAnother={uploadAnother} />
        ) : phase.kind === 'idle' ? (
          <div className="space-y-5">
            {error && <ErrorAlert>{error}</ErrorAlert>}
            <UploadZone maxUploadMb={session.maxUploadMb} onFile={handleFile} buttonRef={chooseButtonRef} />
          </div>
        ) : (
          <ProgressView phase={phase} />
        )}
      </Card>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4 px-4 py-4">
          <h1 className="text-lg font-bold tracking-tight">File → Drive → QR</h1>
          {session?.authenticated && (
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-md px-2 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            >
              Log out
            </button>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:py-12">{content}</main>
      <footer className="border-t border-slate-200 bg-white px-4 py-4 text-center text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        <a
          href="https://devteam0309.github.io/file-qr/docs/index.html"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-sm underline-offset-2 hover:text-slate-900 hover:underline dark:hover:text-slate-100"
        >
          Jorres © 2026
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </footer>
    </div>
  );
}

function ProgressView({ phase }: { phase: Extract<Phase, { kind: 'uploading' | 'saving' }> }) {
  const percent = phase.kind === 'uploading' ? Math.round(phase.progress * 100) : 100;
  const label = phase.kind === 'uploading' ? `Uploading… ${percent}%` : 'Saving to Google Drive…';

  return (
    <div className="space-y-4 py-6" aria-busy="true">
      <p className="truncate text-sm text-slate-600 dark:text-slate-400" title={phase.file.name}>
        {phase.file.name} · {formatBytes(phase.file.size)}
      </p>
      <p role="status" aria-live="polite" className="text-lg font-semibold">
        {label}
      </p>
      <div
        role="progressbar"
        aria-label={phase.kind === 'uploading' ? 'Upload progress' : 'Saving to Google Drive'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={phase.kind === 'uploading' ? percent : undefined}
        className="h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
      >
        <div
          className={`h-full rounded-full bg-indigo-700 transition-[width] duration-200 dark:bg-indigo-400 ${
            phase.kind === 'saving' ? 'animate-pulse' : ''
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {phase.kind === 'saving' && (
        <p className="text-sm text-slate-600 dark:text-slate-400">Upload complete. The server is sending it to Drive and creating a share link.</p>
      )}
    </div>
  );
}
