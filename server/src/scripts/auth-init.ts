/**
 * One-time helper: run `npm run auth:init`, open the printed URL, approve access,
 * then paste the printed GOOGLE_REFRESH_TOKEN into the repo-root .env.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { google } from 'googleapis';
import { ConfigError, loadGoogleClientConfig } from '../config.js';
import { DRIVE_FILE_SCOPE } from '../drive.js';

const PORT = 5555;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const TIMEOUT_MS = 10 * 60 * 1000;

let creds;
try {
  creds = loadGoogleClientConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const oauth2 = new google.auth.OAuth2(creds.GOOGLE_CLIENT_ID, creds.GOOGLE_CLIENT_SECRET, REDIRECT_URI);
const state = crypto.randomBytes(32).toString('hex');

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [DRIVE_FILE_SCOPE],
  state,
});

function stateMatches(received: string | null): boolean {
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(state);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1>${title}</h1><p>${body}</p></body>`;
}

function finish(code: number): never {
  for (const server of servers) server.close();
  process.exit(code);
}

const handleRequest: http.RequestListener = async (req, res) => {
  const url = new URL(req.url ?? '/', REDIRECT_URI);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end();
    return;
  }
  const send = (status: number, title: string, body: string) =>
    new Promise<void>((resolve) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(title, body), resolve);
    });

  if (!stateMatches(url.searchParams.get('state'))) {
    await send(400, 'State mismatch', 'The <code>state</code> parameter did not match. Restart <code>npm run auth:init</code> and use the new URL.');
    console.error('\n✖ Rejected a callback with a missing or mismatched "state" parameter. Waiting for a valid one...');
    return;
  }

  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    await send(400, 'Authorization failed', `Google returned: <code>${oauthError.replace(/[<>&"]/g, '')}</code>`);
    console.error(`\n✖ Google returned an error: ${oauthError}`);
    finish(1);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    await send(400, 'Missing code', 'No authorization code in the callback.');
    console.error('\n✖ Callback did not include an authorization code.');
    finish(1);
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    const grantedScopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
    const hasDriveFile = grantedScopes.includes(DRIVE_FILE_SCOPE);

    console.log('');
    if (!hasDriveFile) {
      console.warn('⚠ WARNING: the drive.file scope was NOT granted.');
      console.warn(`  Granted scopes: ${grantedScopes.join(', ') || '(none reported)'}`);
      console.warn('  On the consent screen, make sure the "See, edit, create and delete only the specific');
      console.warn('  Google Drive files you use with this app" box is checked. Uploads will fail without it.\n');
    }

    if (!tokens.refresh_token) {
      console.warn('⚠ WARNING: Google did not return a refresh token.');
      console.warn('  This usually means the app was already authorized without prompt=consent, or');
      console.warn('  the OAuth client is not a "Web application" client. Remove the app at');
      console.warn('  https://myaccount.google.com/permissions and run `npm run auth:init` again.\n');
      await send(500, 'No refresh token', 'Google did not return a refresh token. See the terminal for what to do next.');
      finish(1);
    }

    console.log('✔ Success! Add this line to the .env file at the repo root:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log('Then restart the server (npm run dev).');
    await send(
      200,
      hasDriveFile ? 'Authorized' : 'Authorized (with warnings)',
      'You can close this tab. The refresh token is printed in your terminal.',
    );
    finish(hasDriveFile ? 0 : 1);
  } catch (err) {
    console.error('\n✖ Failed to exchange the authorization code:', err instanceof Error ? err.message : err);
    await send(500, 'Token exchange failed', 'See the terminal for details.');
    finish(1);
  }
};

// "localhost" may resolve to 127.0.0.1 or ::1 depending on the OS and browser,
// so listen on both loopback addresses (and nothing else).
const HOSTS = ['127.0.0.1', '::1'];
let pending = HOSTS.length;
let listening = 0;

function hostSettled() {
  if (--pending > 0) return;
  if (listening === 0) {
    console.error(`\n✖ Could not listen on port ${PORT} on localhost.`);
    process.exit(1);
  }
  console.log(`\nListening for the OAuth callback on ${REDIRECT_URI}`);
  console.log('(This redirect URI must be listed on your OAuth client in Google Cloud Console.)\n');
  console.log('Open this URL in your browser and approve access:\n');
  console.log(`${authUrl}\n`);
}

const servers = HOSTS.map((host) => {
  const server = http.createServer(handleRequest);
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n✖ Port ${PORT} is already in use. Stop whatever is using it and try again.`);
      process.exit(1);
    }
    // e.g. IPv6 disabled on this machine: carry on with the other address.
    hostSettled();
  });
  server.listen(PORT, host, () => {
    listening++;
    hostSettled();
  });
  return server;
});

setTimeout(() => {
  console.error('\n✖ Timed out after 10 minutes waiting for the OAuth callback.');
  finish(1);
}, TIMEOUT_MS).unref();
