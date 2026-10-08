import path from 'node:path';
import { createApp } from './app.js';
import { ConfigError, loadConfig, repoRoot } from './config.js';
import { DriveService, createDriveClient } from './drive.js';
import { LinkStore, createDbClient } from './links.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const drive = new DriveService(createDriveClient(config), config.DRIVE_FOLDER_NAME);

const links = new LinkStore(createDbClient(config, path.join(repoRoot, 'server', 'data', 'file-qr.db')));
try {
  await links.init();
} catch (err) {
  console.error('\nCould not open the short-link database:', err instanceof Error ? err.message : err);
  if (config.TURSO_DATABASE_URL) console.error('Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.\n');
  process.exit(1);
}
console.log(`[server] Short links stored in ${config.TURSO_DATABASE_URL ? 'Turso' : 'local SQLite (server/data/file-qr.db)'}`);

const clientDistDir = path.join(repoRoot, 'client', 'dist');
const app = createApp(config, { drive, links, clientDistDir });

app.listen(config.PORT, () => {
  console.log(`[server] Listening on http://localhost:${config.PORT}`);
});
