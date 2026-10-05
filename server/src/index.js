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
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
