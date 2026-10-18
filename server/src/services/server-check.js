import { pidFile, runningServerPid } from '../server-pid.js';

// A StudyRevr server answering on the configured port (a server started from another folder has no pid file here).
async function serverAnswers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// null when no server runs on this database, else the message to print. For the scripts that change lessons directly.
export async function serverBlock(config) {
  const pid = runningServerPid(config.dbPath);
  if (!pid && !(await serverAnswers(config.port))) return null;
  const lines = [`The StudyRevr server is running${pid ? ` (process ${pid})` : ` on port ${config.port}`}. Stop it first (Ctrl+C in its window), then run this again.`];
  if (pid) lines.push(`If no server is running (it was closed without stopping, or the number belongs to another program), delete ${pidFile(config.dbPath)} and run this again.`);
  return lines.join('\n');
}
