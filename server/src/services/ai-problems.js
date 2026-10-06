// What admin sees about trouble with the Default AI in the live rewrites (Explain simpler, Filipino/Taglish). Students only
// get "try again" (services/live-rewrite.js); the real reason is here, read from the ai_calls log.

const DAY_MS = 24 * 60 * 60 * 1000;

// Reasons that mean the Default's settings are wrong (not just a busy moment), with what admin should do.
export const DEFAULT_PROBLEMS = {
  not_found: 'The provider doesn’t know the Default model (retired or mistyped). Pick another model above.',
  auth: 'The provider rejected the Default API key. Paste a working key above.',
  no_credit: 'The Default account has no credit or quota left.',
  bad_request: 'The provider rejected the request for the Default model. Pick another model above.',
  not_configured: 'The Default AI isn’t set up (no key or model). Fill it in above.',
};

// The Default step's failures from the last 24 hours (`default:<reason>` in fallback_reasons), only the reasons above.
// -> [{ code, message, count, last_at, answered_by_backup, failed }]; answered_by_backup is how many of those
// requests the backup AI (Gemma) still answered.
export function defaultAiProblems(db, now) {
  const rows = db
    .prepare('SELECT fallback_reasons, source, outcome, created_at FROM ai_calls WHERE created_at >= ? AND fallback_reasons IS NOT NULL ORDER BY id')
    .all(new Date(now.getTime() - DAY_MS).toISOString());
  const found = new Map();
  for (const row of rows) {
    const codes = new Set(
      row.fallback_reasons
        .split(';')
        .filter((r) => r.startsWith('default:'))
        .map((r) => r.slice('default:'.length))
        .filter((code) => code in DEFAULT_PROBLEMS),
    );
    for (const code of codes) {
      const entry = found.get(code) ?? { code, message: DEFAULT_PROBLEMS[code], count: 0, last_at: null, answered_by_backup: 0, failed: 0 };
      entry.count += 1;
      entry.last_at = row.created_at;
      if (row.outcome === 'ok') entry.answered_by_backup += 1;
      else entry.failed += 1;
      found.set(code, entry);
    }
  }
  return [...found.values()];
}
