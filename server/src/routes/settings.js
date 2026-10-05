import { Router } from 'express';

// AI provider endpoints. Phase 7 adds GET/PUT / (the Settings screen) to this router.
export function settingsRouter(ai) {
  const router = Router();

  // Chat-capable models the provider offers ({base URL}/models), sorted.
  router.get('/models', async (_req, res) => {
    res.json({ models: await ai.listModels() });
  });

  // Tiny chat request that must come back as a small JSON object. Failures use the usual JSON error shape
  // ({ error: { message, code } }) with 400 (not configured), 502 (provider) or 504 (timeout).
  router.post('/test-ai', async (_req, res) => {
    res.json(await ai.testConnection());
  });

  return router;
}
