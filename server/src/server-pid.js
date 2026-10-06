import fs from 'node:fs';

// The running server writes its process id next to the database (studyrevr.db.pid), so `npm run restore` can refuse
// to replace the database under it. A file left by a server that crashed names a process that no longer runs.
export const pidFile = (dbPath) => `${dbPath}.pid`;

export function writePidFile(dbPath, pid = process.pid) {
  if (dbPath === ':memory:') return;
  fs.writeFileSync(pidFile(dbPath), `${pid}\n`);
}

export function removePidFile(dbPath, pid = process.pid) {
  if (dbPath === ':memory:') return;
  try {
    if (Number(fs.readFileSync(pidFile(dbPath), 'utf8').trim()) === pid) fs.rmSync(pidFile(dbPath));
  } catch {
    // already gone
  }
}

// The pid of a server running on this database, or null.
export function runningServerPid(dbPath) {
  let pid;
  try {
    pid = Number(fs.readFileSync(pidFile(dbPath), 'utf8').trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // signal 0: only checks that the process exists
    return pid;
  } catch (err) {
    return err.code === 'EPERM' ? pid : null; // EPERM: it exists, but belongs to another user
  }
}
