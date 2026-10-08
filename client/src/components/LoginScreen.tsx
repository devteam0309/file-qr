import { useState, type FormEvent } from 'react';
import { login } from '../api';
import { Card, ErrorAlert, buttonStyles } from './ui';

interface Props {
  notice?: string | null;
  onLoggedIn: () => void;
}

export function LoginScreen({ notice, onLoggedIn }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(password);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <h2 className="text-xl font-semibold">Enter password</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Uploads go to a private Google Drive, so this app is password protected.
          </p>
        </div>

        {notice && !error && (
          <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">{notice}</p>
        )}
        {error && <ErrorAlert>{error}</ErrorAlert>}

        <div className="space-y-1.5">
          <label htmlFor="password" className="block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-slate-900 placeholder:text-slate-500 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
          />
        </div>

        <button type="submit" disabled={busy || password === ''} className={`${buttonStyles.primary} w-full`}>
          {busy ? 'Checking…' : 'Log in'}
        </button>
      </form>
    </Card>
  );
}
