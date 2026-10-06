import { Router } from 'express';
import { AiError } from '../ai/client.js';
import { isProviderId, PRESETS } from '../ai/providers.js';
import { HttpError } from '../middleware/errors.js';
import { loadSchedulerConfig } from '../flashcards/config.js';
import { aiSettingsBody, appSettingsBody, describeAiSettings, describeAppSettings, resolveAiConfig, saveAiSettings, saveAppSettings } from '../services/settings.js';

// Reads a request body with the zod schema; the first problem becomes a 400 that names the field.
function parseBody(body, schema = aiSettingsBody) {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue.path.join('.');
  throw new HttpError(400, field ? `Invalid ${field}: ${issue.message}.` : `Invalid request: ${issue.message}.`);
}

// Admin settings (all behind the PIN): the app settings and the AI provider. API keys are only ever written here,
// never returned: responses carry a `keySet` flag.
export function settingsRouter({ ai, db, config }) {
  const router = Router();
  const envAi = config.ai ?? {};
  const appSettings = () => describeAppSettings(db, loadSchedulerConfig(db));

  // New flashcards per day and whether students may use their own AI key.
  router.get('/', (_req, res) => res.json(appSettings()));
  router.put('/', (req, res) => {
    saveAppSettings(db, parseBody(req.body, appSettingsBody));
    res.json(appSettings());
  });

  // The active provider, each provider's saved model / base URL, and whether its key is set.
  router.get('/ai', (_req, res) => {
    res.json(describeAiSettings(db, envAi));
  });

  // Saves the active provider and/or one provider's model, base URL or key. Any model id is accepted: the list from
  // GET /models is a convenience, not a whitelist. An empty string clears a saved value.
  router.put('/ai', (req, res) => {
    saveAiSettings(db, parseBody(req.body), envAi);
    res.json(describeAiSettings(db, envAi));
  });

  // Chat-capable models the provider offers ({base URL}/models), sorted. ?provider=<id> browses a provider other than
  // the active one. If the provider can't be asked or lists nothing, the answer is still 200 with `models: []` and
  // `freeText: true`, so the Settings screen can fall back to typing a model id.
  router.get('/models', async (req, res) => {
    const provider = isProviderId(req.query.provider) ? req.query.provider : undefined;
    const cfg = resolveAiConfig(db, envAi, { provider });
    const answer = { provider: cfg.provider, current: cfg.model, defaultModel: PRESETS[cfg.provider].model };
    try {
      const models = await ai.listModels(cfg);
      res.json({ ...answer, models, freeText: models.length === 0 });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      res.json({ ...answer, models: [], freeText: true, error: { code: err.code, message: err.message } });
    }
  });

  // Tiny chat request that must come back as a small JSON object. The body ({ provider, model, baseUrl, apiKey },
  // all optional) is tried as given, without saving, so Settings can test before saving; anything left out comes
  // from the saved settings, .env or the preset. Failures use the usual JSON error shape ({ error: { message, code } })
  // with 400 (not configured), 502 (provider) or 504 (timeout).
  router.post('/test-ai', async (req, res) => {
    const cfg = resolveAiConfig(db, envAi, parseBody(req.body));
    const result = await ai.testConnection(cfg);
    res.json({ ...result, provider: cfg.provider });
  });

  return router;
}
