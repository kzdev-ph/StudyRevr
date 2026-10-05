import { DEFAULT_CHUNK_TOKENS } from '../ai/chunk.js';
import { runPipeline } from './run.js';

// Runs lesson jobs one at a time in the background, in upload order. One at a time keeps a local model from being
// swamped and a hosted provider from rate-limiting us. `enqueue` returns immediately; clients poll the status.
export function createPipelineRunner({ db, ai, chunkTokens = DEFAULT_CHUNK_TOKENS, log = console }) {
  let tail = Promise.resolve();
  return {
    enqueue(lessonId) {
      tail = tail.then(() => runPipeline({ db, ai, lessonId, chunkTokens, log })).catch((err) => log.error('[pipeline] unexpected:', err));
    },
    // Resolves when everything enqueued so far has finished (tests and scripts).
    idle: () => tail,
  };
}
