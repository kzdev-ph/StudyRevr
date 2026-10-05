import { z } from 'zod';
import { bareModelId, parseTemperature, DEFAULT_PROVIDER, inferProvider, isProviderId, PRESETS, PROVIDER_IDS } from '../ai/providers.js';

// Reads a boolean from the settings table; a missing or unrecognised value falls back to `fallback`.
export function getBoolSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  const v = String(row.value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

// Reads a trimmed string setting; '' when the row is missing or blank.
export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value?.trim() ?? '';
}

// A positive whole number, or undefined when the row is missing or not one.
export function getIntSetting(db, key) {
  const n = Math.floor(Number(getSetting(db, key)));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// A sampling temperature (0 to 2), or undefined when the row is missing or not one.
const getTemperatureSetting = (db, key) => parseTemperature(getSetting(db, key));

function setSetting(db, key, value) {
  if (value === '') db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export const DEFAULT_KEY_TERMS_MAX = 12;
const MAX_KEY_TERMS_LIMIT = 50;

// Per-provider settings keys, so switching providers in Settings brings back each provider's last model, URL and key.
const providerKey = (field, provider) => `ai_${field}:${provider}`;

// The AI provider to use and how: { provider, label, baseUrl, apiKey, model, chunkTokens, concurrency, extraBody,
// jsonSchema, needsKey, keyEnv, keyTermsMax }. Each value resolves as: `overrides` (a one-off request, e.g. "test this
// provider before saving") > the Settings screen (settings table) > .env > the provider preset.
//
// The .env overrides AI_BASE_URL / AI_API_KEY / AI_MODEL / AI_EXTRA_BODY belong to the provider named by AI_PROVIDER
// (or inferred from AI_BASE_URL) and are ignored for any other provider, so they can't leak into a provider you
// switch to. Never log or return this object: it holds the API key.
export function resolveAiConfig(db, envAi = {}, overrides = {}) {
  const envProvider = [envAi.provider, inferProvider(envAi.baseUrl)].find(isProviderId) ?? DEFAULT_PROVIDER;
  const provider = [overrides.provider, getSetting(db, 'ai_provider'), envProvider].find(isProviderId) ?? DEFAULT_PROVIDER;
  const preset = PRESETS[provider];
  const env = provider === envProvider ? envAi : {}; // overrides that belong to this provider only

  const saved = (field) => getSetting(db, providerKey(field, provider));
  const apiKey = overrides.apiKey || saved('api_key') || env.apiKey || envAi.keys?.[provider] || '';
  return {
    provider,
    label: preset.label,
    baseUrl: overrides.baseUrl || saved('base_url') || env.baseUrl || preset.baseUrl,
    apiKey,
    model: bareModelId(overrides.model || saved('model') || env.model || preset.model),
    chunkTokens: getIntSetting(db, 'ai_chunk_tokens') ?? envAi.chunkTokens ?? preset.chunkTokens,
    concurrency: getIntSetting(db, 'ai_concurrency') ?? envAi.concurrency ?? preset.concurrency,
    temperature: getTemperatureSetting(db, 'ai_temperature') ?? envAi.temperature ?? preset.temperature,
    timeoutMs: envAi.timeoutMs ?? preset.timeoutMs,
    extraBody: env.extraBody,
    jsonSchema: preset.jsonSchema,
    needsKey: preset.needsKey,
    keyEnv: preset.keyEnv,
    keyTermsMax: Math.min(getIntSetting(db, 'key_terms_max') ?? envAi.keyTermsMax ?? DEFAULT_KEY_TERMS_MAX, MAX_KEY_TERMS_LIMIT),
  };
}

// What the Settings screen may see: never an API key, only whether one is set.
export function describeAiSettings(db, envAi = {}) {
  const active = resolveAiConfig(db, envAi);
  return {
    provider: active.provider,
    keyTermsMax: active.keyTermsMax,
    providers: PROVIDER_IDS.map((id) => {
      const c = resolveAiConfig(db, envAi, { provider: id });
      const preset = PRESETS[id];
      return {
        id,
        label: preset.label,
        baseUrl: c.baseUrl,
        model: c.model,
        defaultModel: preset.model,
        keySet: Boolean(c.apiKey),
        needsKey: preset.needsKey,
        chunkTokens: c.chunkTokens,
        concurrency: c.concurrency,
      };
    }),
  };
}

// Request body for PUT /api/settings/ai and POST /api/settings/test-ai. Empty strings clear a saved value.
const optionalUrl = z.union([z.literal(''), z.url({ protocol: /^https?$/ })]);
export const aiSettingsBody = z.strictObject({
  provider: z.enum(PROVIDER_IDS).optional(),
  model: z.string().trim().max(200).optional(),
  baseUrl: optionalUrl.optional(),
  apiKey: z.string().trim().max(500).optional(),
});

// Saves the active provider and, for the chosen provider (default: the active one), its model / base URL / key.
export function saveAiSettings(db, input, envAi = {}) {
  const provider = input.provider ?? resolveAiConfig(db, envAi).provider;
  db.transaction(() => {
    if (input.provider) setSetting(db, 'ai_provider', input.provider);
    if (input.model !== undefined) setSetting(db, providerKey('model', provider), bareModelId(input.model));
    if (input.baseUrl !== undefined) setSetting(db, providerKey('base_url', provider), input.baseUrl);
    if (input.apiKey !== undefined) setSetting(db, providerKey('api_key', provider), input.apiKey);
  })();
}
