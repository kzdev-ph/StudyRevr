import os from 'node:os';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb, runMigrations } from './db/index.js';
import { failInterruptedJobs } from './pipeline/jobs.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const applied = runMigrations(db);
if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);

const interrupted = failInterruptedJobs(db);
if (interrupted) console.log(`[pipeline] marked ${interrupted} unfinished lesson(s) as failed after a restart; they can be retried`);

const app = createApp(db, config);
const server = app.listen(config.port, () => {
  console.log(`[server] StudyRevr API on http://localhost:${config.port}  (db: ${config.dbPath})`);
  // the addresses phones on the same Wi-Fi can open (when the app is built: npm run study)
  const lan = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal);
  for (const a of lan) console.log(`[server] on this network: http://${a.address}:${config.port}`);
  if (!config.adminPin) console.log('[server] admin is off: set ADMIN_PIN in .env to upload lessons, add participants and export data');
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
