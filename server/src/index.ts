import path from 'node:path';
import { createApp } from './app.js';
import { ConfigError, loadConfig, repoRoot } from './config.js';
import { DriveService, createDriveClient } from './drive.js';

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
const clientDistDir = path.join(repoRoot, 'client', 'dist');
const app = createApp(config, { drive, clientDistDir });

app.listen(config.PORT, () => {
  console.log(`[server] Listening on http://localhost:${config.PORT}`);
});
