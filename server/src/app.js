import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createAdminGuard } from './middleware/admin.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { createAiClient, describeAttempt } from './ai/client.js';
import { createPipelineRunner } from './pipeline/runner.js';
import { adminRouter } from './routes/admin.js';
import { flashcardsRouter } from './routes/flashcards.js';
import { lessonsRouter } from './routes/lessons.js';
import { myAiRouter } from './routes/my-ai.js';
import { myUploadsRouter } from './routes/my-uploads.js';
import { participantsRouter } from './routes/participants.js';
import { quizRouter } from './routes/quiz.js';
import { sectionsRouter } from './routes/sections.js';
import { sessionsRouter } from './routes/sessions.js';
import { settingsRouter } from './routes/settings.js';
import { statsRouter } from './routes/stats.js';
import { createAccess } from './services/lesson-access.js';
import { resolveAiConfig } from './services/settings.js';

// `ai` and `runner` default to the real provider client and background job runner; tests inject stubs, and a fake
// `clock` (() => Date) for the flashcard scheduler, the quiz, sessions and stats, and `random` (() => [0, 1)) for quiz
// shuffles.
export function createApp(db, config, { ai, runner, clock = () => new Date(), random } = {}) {
  ai ??= createAiClient({
    getConfig: () => resolveAiConfig(db, config.ai),
    // every HTTP attempt to the provider (start, end, failure reason), so a hung or retried request shows in the log
    onAttempt: (e) => (e.type === 'fail' ? console.warn : console.log)(`[ai] ${describeAttempt(e)}`),
  });
  runner ??= createPipelineRunner({
    db,
    ai,
    clock,
    tuning: () => {
      const { chunkTokens, concurrency, keyTermsMax, provider, model } = resolveAiConfig(db, config.ai);
      return { chunkTokens, concurrency, keyTermsMax, madeBy: { provider, model } };
    },
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Admin routes (ADMIN_PIN): lesson upload / retry / delete, making cards, participant codes, AI settings, export.
  const requireAdmin = createAdminGuard({ pin: config.adminPin, clock: () => clock().getTime() });

  // who may see which lesson (services/lesson-access.js); the PIN check is shared with requireAdmin
  const access = createAccess({ db, requireAdmin });

  // Every router is mounted through this, which also tags it with its prefix: Express keeps no readable prefix on a
  // mounted router, and test/lesson-access.test.js walks the live router stack to list every route with its full path
  // (a router mounted any other way fails that test, so a new route can't slip past the visibility checks).
  const mount = (prefix, ...handlers) => {
    handlers.at(-1).mountPath = prefix;
    app.use(prefix, ...handlers);
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true, admin: Boolean(config.adminPin) }));
  mount('/api/admin', adminRouter({ db, ai, clock, requireAdmin }));
  mount('/api', participantsRouter({ db }));
  mount('/api', sessionsRouter({ db, clock, access }));
  mount('/api', statsRouter({ db, clock }));
  mount('/api', flashcardsRouter({ db, runner, clock, requireAdmin, access }));
  mount('/api', quizRouter({ db, ai, clock, random, access, tuning: () => ({ concurrency: resolveAiConfig(db, config.ai).concurrency }) }));
  mount('/api/lessons', lessonsRouter(db, config, runner, requireAdmin, { access, clock }));
  mount('/api', myAiRouter({ ai, db, config, clock }));
  mount('/api', myUploadsRouter({ db, config, clock }));
  mount('/api/sections', sectionsRouter({ ai, db, config, clock, access }));
  mount('/api/settings', requireAdmin, settingsRouter({ ai, db, config, clock }));

  app.use('/api', notFound);
  serveClient(app, config.clientDist);
  app.use(errorHandler(config.maxUploadBytes));
  return app;
}

// The built React app, when there is one (npm run study builds it): phones on the Wi-Fi open one address. Any path
// that isn't a file gets index.html (the app routes with #/ hashes, so this is only the bare page).
function serveClient(app, dist) {
  if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) return;
  app.use(express.static(dist, { index: 'index.html', maxAge: '1h', setHeaders: (res, file) => file.endsWith('.html') && res.set('cache-control', 'no-cache') }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html'), { headers: { 'cache-control': 'no-cache' } }));
}
