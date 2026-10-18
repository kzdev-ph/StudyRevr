import { z } from 'zod';
import { bareModelId, modelTuning, parseTemperature, DEFAULT_PROVIDER, inferProvider, isProviderId, PRESETS, PROVIDER_IDS } from '../ai/providers.js';

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

export function setSetting(db, key, value) {
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
  const model = bareModelId(overrides.model || saved('model') || env.model || preset.model);
  const tuning = modelTuning(provider, model);
  return {
    provider,
    label: preset.label,
    baseUrl: overrides.baseUrl || saved('base_url') || env.baseUrl || preset.baseUrl,
    apiKey,
    model,
    chunkTokens: getIntSetting(db, 'ai_chunk_tokens') ?? envAi.chunkTokens ?? preset.chunkTokens,
    concurrency: getIntSetting(db, 'ai_concurrency') ?? envAi.concurrency ?? preset.concurrency,
    temperature: getTemperatureSetting(db, 'ai_temperature') ?? envAi.temperature ?? preset.temperature,
    timeoutMs: envAi.timeoutMs ?? tuning.timeoutMs, // AI_TIMEOUT_SECONDS > the model's tuning > the preset
    requestsPerMinute: tuning.requestsPerMinute, // client-side limit, from the preset's model tuning (none: unlimited)
    // the model's own options (Gemma's reasoning_effort), then AI_EXTRA_BODY for the .env provider
    extraBody: tuning.extraBody || env.extraBody ? { ...tuning.extraBody, ...env.extraBody } : undefined,
    jsonSchema: preset.jsonSchema,
    reasoningEffort: Boolean(preset.reasoningEffort),
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

// The app settings admin changes besides the AI provider (GET / PUT /api/settings).
//   flashcard_new_per_day     new flashcards a participant is shown per study day (scheduler default 20)
//   allow_student_keys        students may use their own AI key for Explain simpler and Filipino/Taglish (default off)
//   allow_student_uploads     students may upload their own lessons (default off)
//   student_uploads_per_day   uploads per student per study day (default 2)
//   show_taglish              students see the Filipino/Taglish button (default off; admin's Prepare still makes the versions)
//   lesson_thinking           'minimal' | 'low' | 'medium' | 'high': how hard lesson processing asks the model to think (reasoning_effort;
//                             'minimal' sends nothing, the old 'off'; default 'low' (migration 016); live Explain simpler /
//                             Filipino-Taglish never think)
export const DEFAULT_UPLOADS_PER_DAY = 2;
export const LESSON_THINKING = ['minimal', 'low', 'medium', 'high'];
export const DEFAULT_LESSON_THINKING = 'low'; // measured: see CLAUDE.md, Thinking for lesson processing
export function lessonThinking(db) {
  const value = getSetting(db, 'lesson_thinking');
  if (value === 'off') return 'minimal'; // the setting's old name for no thinking
  return LESSON_THINKING.includes(value) ? value : DEFAULT_LESSON_THINKING;
}
export const appSettingsBody = z.strictObject({
  flashcard_new_per_day: z.number().int().min(0).max(9999).optional(),
  allow_student_keys: z.boolean().optional(),
  allow_student_uploads: z.boolean().optional(),
  student_uploads_per_day: z.number().int().min(0).max(20).optional(),
  lesson_thinking: z.enum(LESSON_THINKING).optional(),
  show_taglish: z.boolean().optional(),
});

// Uploads each student may make per study day (0 is allowed: nobody can).
export function uploadsPerDay(db) {
  const n = Number(getSetting(db, 'student_uploads_per_day'));
  return getSetting(db, 'student_uploads_per_day') !== '' && Number.isInteger(n) && n >= 0 ? n : DEFAULT_UPLOADS_PER_DAY;
}

export const studentUploadsAllowed = (db) => getBoolSetting(db, 'allow_student_uploads', false);

// "Show Filipino/Taglish to students": off by default, so the study runs with English only unless the researcher turns it on.
export const taglishShown = (db) => getBoolSetting(db, 'show_taglish', false);

export function describeAppSettings(db, { newPerDay }) {
  return {
    flashcard_new_per_day: newPerDay,
    allow_student_keys: getBoolSetting(db, 'allow_student_keys', false),
    student_keys_saved: db.prepare('SELECT COUNT(*) AS n FROM participant_ai_keys').get().n,
    allow_student_uploads: studentUploadsAllowed(db),
    student_uploads_per_day: uploadsPerDay(db),
    lesson_thinking: lessonThinking(db),
    show_taglish: taglishShown(db),
  };
}

// Saves what was sent. Returns the settings that really changed, [{ key, value }], so the route can log each one in
// admin_events (a save that changes nothing logs nothing).
export function saveAppSettings(db, input, current = null) {
  const before = current ?? { ...describeAppSettings(db, { newPerDay: undefined }) };
  const changed = [];
  const put = (key, value, was) => {
    if (value === undefined) return;
    setSetting(db, key, String(value));
    if (was === undefined || String(was) !== String(value)) changed.push({ key, value: String(value) });
  };
  db.transaction(() => {
    put('flashcard_new_per_day', input.flashcard_new_per_day, before.flashcard_new_per_day);
    put('allow_student_keys', input.allow_student_keys, before.allow_student_keys);
    put('allow_student_uploads', input.allow_student_uploads, before.allow_student_uploads);
    put('student_uploads_per_day', input.student_uploads_per_day, before.student_uploads_per_day);
    put('lesson_thinking', input.lesson_thinking, before.lesson_thinking);
    put('show_taglish', input.show_taglish, before.show_taglish);
  })();
  return changed;
}
