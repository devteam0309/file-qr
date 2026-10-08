# File → Drive → QR

Upload a file in the browser, the server saves it to **your** Google Drive, and you get a QR code that links to it.

- `client/`: React + Vite + TypeScript + Tailwind CSS
- `server/`: Node.js + Express + TypeScript
- No database and no user accounts. One shared password protects uploads.
- The browser never talks to Google. All Drive calls happen on the server, using OAuth 2.0 with a stored refresh token for one Google account and only the `drive.file` scope.

## How it works

1. `POST /api/upload` receives the file into a temp directory (multer, disk storage, `MAX_UPLOAD_MB` limit).
2. On the first upload the server finds or creates its own Drive folder (named `DRIVE_FOLDER_NAME`, tagged with `appProperties` so it's found again even if you rename it) and caches the folder id.
3. The file is streamed from disk to Drive, then shared as "anyone with the link can view" (not discoverable). If sharing fails, the uploaded Drive file is deleted so nothing is left behind.
4. The temp file is always deleted.
5. The browser renders the QR code locally from the returned link.

Drive calls that get a 429 or 5xx response are retried up to 3 times with exponential backoff.

## Requirements

- Node.js 20 or newer (tested on 24)
- A Google account (personal Gmail or Google Workspace)

## Setup

### 1. Google Cloud project + Drive API

1. Go to <https://console.cloud.google.com/> and create a project (top bar → project picker → **New project**).
2. With that project selected, open **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.

### 2. OAuth consent screen

Open **APIs & Services → OAuth consent screen** (in newer consoles this is **Google Auth Platform → Branding / Audience / Data access**).

1. **User type / Audience:**
   - Personal Gmail account: choose **External**.
   - Google Workspace account: choose **Internal** (only users in your organization can authorize; no publishing or review needed).
2. Fill in the app name, support email, and developer contact email.
3. **Scopes / Data access:** click **Add or remove scopes** and add
   `https://www.googleapis.com/auth/drive.file`
   ("See, edit, create, and delete only the specific Google Drive files you use with this app"). Add nothing else.
4. **Test users** (External only): add your own Google account's email.
5. **External only: click "Publish app"** (Audience → Publishing status → **Publish app**, then confirm).
   While the app is in **Testing** mode, Google expires refresh tokens after **7 days**, and uploads will then fail with `invalid_grant`.
   `drive.file` is a non-sensitive scope, so publishing doesn't require Google's verification. When you authorize you may still see an "unverified app" screen; click **Advanced → Go to (app name)**.

### 3. OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID** (or **Google Auth Platform → Clients → Create client**).
2. Application type: **Web application**.
3. Under **Authorized redirect URIs**, add exactly:
   ```
   http://localhost:5555/oauth2callback
   ```
4. Click **Create** and copy the **Client ID** and **Client secret**.

### 4. Configure `.env` and get a refresh token

From the repo root:

```bash
npm install
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
```

Edit `.env` and fill in:

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From step 3 |
| `DRIVE_FOLDER_NAME` | Folder name to create in your Drive (default `File QR Uploads`) |
| `APP_PASSWORD` | The password you'll type in the web UI (min 8 characters) |
| `SESSION_SECRET` | Output of `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `MAX_UPLOAD_MB` | Upload size limit (default 50) |
| `PORT` | Express port (default 3001) |

Then run the one-time auth script:

```bash
npm run auth:init
```

It starts a temporary server on `http://localhost:5555/oauth2callback` and prints a consent URL. Open it, sign in with the Google account whose Drive should receive the files, and approve. The terminal then prints:

```
GOOGLE_REFRESH_TOKEN=1//0g...
```

Paste that line into `.env`. The script warns you if Google didn't return a refresh token or if the `drive.file` scope wasn't granted. If that happens, follow the printed instructions and run it again.

(`npm run auth:init` works from the repo root or from `server/`.)

### 5. Run it

```bash
npm run dev
```

- UI: <http://localhost:5173> (Vite; proxies `/api` to the server)
- API: <http://localhost:3001>

The server checks `.env` on startup and exits with a list of anything missing or invalid.

### 6. Production

#### Option A: Render (recommended for sharing with others)

`render.yaml` in the repo root defines everything. Render builds the client and server, runs one Node process that serves both, and puts it behind HTTPS on `https://<name>.onrender.com`.

1. Push this repo to GitHub (`.env` is git-ignored, so no secrets are pushed).
2. At <https://dashboard.render.com> sign in with GitHub, then **New → Blueprint** and pick this repository.
3. Render asks for the four secret values. Copy them from your local `.env`:
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `APP_PASSWORD`.
   (`SESSION_SECRET` is generated by Render; `TRUST_PROXY`, `DRIVE_FOLDER_NAME`, `MAX_UPLOAD_MB` and `NODE_VERSION` are preset in `render.yaml`.)
4. Click **Apply**. The first build takes a few minutes. Open the `onrender.com` URL when it shows **Live**.

Notes:
- The **free** plan sleeps after 15 minutes without traffic; the next visit takes up to about a minute to wake up. Upgrade the plan in Render if that matters.
- Every push to the connected branch redeploys automatically.
- If the refresh token is ever replaced (`npm run auth:init` again), update `GOOGLE_REFRESH_TOKEN` under the service's **Environment** tab in Render.
- Upload rate limiting counts per logged-in browser, so a whole office behind one public IP doesn't share a single limit.

#### Option B: your own server

```bash
npm run build      # builds client/dist and server/dist
npm start          # node server/dist/index.js, serves the UI and /api on PORT
```

Put it behind HTTPS with a reverse proxy (Caddy, nginx, a cloud load balancer). Set `TRUST_PROXY=1` in `.env` so the server sees HTTPS (the session cookie gets the `Secure` flag) and rate limiting uses real client IPs.

## Scripts (repo root)

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the server (tsx watch) and client (Vite) together |
| `npm run build` | Typechecks and builds both |
| `npm start` | Runs the built server (serves `client/dist` too) |
| `npm run typecheck` | `tsc --noEmit` on both sides |
| `npm test` | Server tests (Vitest + Supertest, Drive API mocked) |
| `npm run auth:init` | One-time OAuth flow that prints `GOOGLE_REFRESH_TOKEN` |

## API

| Route | Auth | Description |
| --- | --- | --- |
| `GET /api/session` | none | `{ authenticated, maxUploadMb }` |
| `POST /api/login` | none | JSON `{ password }`. Sets an httpOnly, SameSite=Strict JWT cookie valid for 12h. Rate limited (10 failed attempts per 15 min). |
| `POST /api/logout` | none | Clears the cookie |
| `POST /api/upload` | cookie | Multipart, field `file`. Returns `{ fileId, name, size, link }`. Rate limited (30 per 15 min per login session). |

Errors always have the shape `{ "error": { "message": "..." } }`.

## Troubleshooting

- **"Google rejected the stored refresh token (invalid_grant)"**: the token expired or was revoked. The usual causes: the consent screen is still in Testing mode (7-day expiry), you changed your Google password, or you removed the app's access. Run `npm run auth:init` again, update `.env`, and restart.
- **No refresh token returned**: remove the app at <https://myaccount.google.com/permissions> and run `npm run auth:init` again.
- **`redirect_uri_mismatch`**: the OAuth client must be type *Web application* with `http://localhost:5555/oauth2callback` listed exactly.
- **Can't find the folder in Drive**: it's created on the first upload, in My Drive, named `DRIVE_FOLDER_NAME`. If you delete it, the next upload creates a new one.
