// Who wrote a lesson's generated content (lessons.made_by): 'gemini' (the pipeline with the admin Default AI, the
// default), 'claude-haiku' (imported with `npm run lesson:import`) or 'mixed' (a Claude-written lesson that the Default
// AI later changed). `lesson:rebuild` sets it back to 'gemini', an import sets it to 'claude-haiku'.
export const MADE_BY_CLAUDE = 'claude-haiku';
export const MADE_BY_MIXED = 'mixed';
export const CLAUDE_MADE_BY = { provider: 'claude', model: 'haiku' };

// Whether `madeBy` (the { provider, model } a pipeline run records) is the file-backed Claude import, not a real AI.
export const isClaudeImport = (madeBy) => madeBy?.provider === CLAUDE_MADE_BY.provider;

// The Default AI is about to work on (or has changed) a lesson: if Claude wrote it, it is now mixed. A no-op for any
// other lesson. Marked when the work starts rather than when it succeeds, since a failed run may already have saved
// part of it (reviews, rewritten cards, wrong answers); the provenance may over-claim a change, never hide one.
export function markMixedIfClaude(db, lessonId) {
  return db.prepare('UPDATE lessons SET made_by = ? WHERE id = ? AND made_by = ?').run(MADE_BY_MIXED, lessonId, MADE_BY_CLAUDE).changes > 0;
}
