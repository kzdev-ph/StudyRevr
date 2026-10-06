import express from 'express';
import { errorHandler, notFound } from './middleware/errors.js';
import { createAiClient, describeAttempt } from './ai/client.js';
import { createPipelineRunner } from './pipeline/runner.js';
import { flashcardsRouter } from './routes/flashcards.js';
import { lessonsRouter } from './routes/lessons.js';
import { quizRouter } from './routes/quiz.js';
import { sectionsRouter } from './routes/sections.js';
import { settingsRouter } from './routes/settings.js';
import { resolveAiConfig } from './services/settings.js';

// `ai` and `runner` default to the real provider client and background job runner; tests inject stubs, and a fake
// `clock` (() => Date) for the flashcard scheduler and the quiz, and `random` (() => [0, 1)) for quiz shuffles.
export function createApp(db, config, { ai, runner, clock, random } = {}) {
  ai ??= createAiClient({
    getConfig: () => resolveAiConfig(db, config.ai),
    // every HTTP attempt to the provider (start, end, failure reason), so a hung or retried request shows in the log
    onAttempt: (e) => (e.type === 'fail' ? console.warn : console.log)(`[ai] ${describeAttempt(e)}`),
  });
  runner ??= createPipelineRunner({
    db,
    ai,
    tuning: () => {
      const { chunkTokens, concurrency, keyTermsMax } = resolveAiConfig(db, config.ai);
      return { chunkTokens, concurrency, keyTermsMax };
    },
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', flashcardsRouter({ db, runner, clock }));
  app.use('/api', quizRouter({ db, ai, clock, random, tuning: () => ({ concurrency: resolveAiConfig(db, config.ai).concurrency }) }));
  app.use('/api/lessons', lessonsRouter(db, config, runner));
  app.use('/api/sections', sectionsRouter({ ai, db }));
  app.use('/api/settings', settingsRouter({ ai, db, config }));

  app.use('/api', notFound);
  app.use(errorHandler(config.maxUploadBytes));
  return app;
}
