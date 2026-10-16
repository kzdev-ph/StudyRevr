import { runPipeline } from './run.js';

// Runs lesson jobs one at a time in the background, in upload order. Lessons run one at a time, but the AI calls
// inside a lesson's stage run in parallel (up to `concurrency`). `enqueue` returns immediately; clients poll the status.
// `tuning()` ({ chunkTokens, concurrency, keyTermsMax }) is read when each lesson starts, so a provider or model
// switched in Settings applies to the next lesson without a restart; the plain options are the fixed fallback.
export function createPipelineRunner({ db, ai, chunkTokens, concurrency, keyTermsMax, tuning, log = console, clock = () => new Date() }) {
  let tail = Promise.resolve();
  return {
    enqueue(lessonId) {
      tail = tail
        .then(() => runPipeline({ db, ai, lessonId, chunkTokens, concurrency, keyTermsMax, ...tuning?.(), log, clock }))
        .catch((err) => log.error('[pipeline] unexpected:', err));
    },
    // Resolves when everything enqueued so far has finished (tests and scripts).
    idle: () => tail,
  };
}
