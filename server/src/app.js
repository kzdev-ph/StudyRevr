import express from 'express';
import { errorHandler, notFound } from './middleware/errors.js';
import { lessonsRouter } from './routes/lessons.js';

export function createApp(db, config) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/lessons', lessonsRouter(db, config));

  app.use('/api', notFound);
  app.use(errorHandler(config.maxUploadBytes));
  return app;
}
