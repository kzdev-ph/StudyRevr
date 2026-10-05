import express from 'express';
import { errorHandler, notFound } from './middleware/errors.js';
import { createAiClient } from './ai/client.js';
import { createPipelineRunner } from './pipeline/runner.js';
import { lessonsRouter } from './routes/lessons.js';
import { settingsRouter } from './routes/settings.js';
import { resolveAiConfig } from './services/settings.js';

// `ai` and `runner` default to the real provider client and background job runner; tests inject stubs.
export function createApp(db, config, { ai, runner } = {}) {
  ai ??= createAiClient({
    getConfig: () => resolveAiConfig(db, config.ai),
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
  app.use('/api/lessons', lessonsRouter(db, config, runner));
  app.use('/api/settings', settingsRouter({ ai, db, config }));

  app.use('/api', notFound);
  app.use(errorHandler(config.maxUploadBytes));
  return app;
}
