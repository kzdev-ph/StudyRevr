import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const resolveDbPath = (p) => (p === ':memory:' || path.isAbsolute(p) ? p : path.join(ROOT_DIR, p));

const positiveInt = (value) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const extraBodySchema = z.record(z.string(), z.unknown());

// AI_EXTRA_BODY: a JSON object merged into every chat request (provider options such as turning thinking off).
// Anything that isn't a JSON object is ignored, with a warning that never repeats the value.
export function parseExtraBody(raw, warn = console.warn) {
  if (!raw || !String(raw).trim()) return undefined;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    warn('[config] AI_EXTRA_BODY ignored: it is not valid JSON.');
    return undefined;
  }
  const parsed = extraBodySchema.safeParse(value);
  if (!parsed.success) {
    warn('[config] AI_EXTRA_BODY ignored: it must be a JSON object, e.g. {"reasoning_effort":"none"}.');
    return undefined;
  }
  return parsed.data;
}

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3001,
    dbPath: resolveDbPath(env.DB_PATH || 'server/data/studyrevr.db'),
    maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 20) * 1024 * 1024,
    ai: {
      provider: (env.AI_PROVIDER || '').trim().toLowerCase(), // google (default) | nvidia-nim | openrouter | ollama | llamacpp | custom
      // Optional overrides; they apply to the provider named by AI_PROVIDER (or inferred from AI_BASE_URL).
      baseUrl: env.AI_BASE_URL || '',
      apiKey: env.AI_API_KEY || '',
      model: env.AI_MODEL || '',
      extraBody: parseExtraBody(env.AI_EXTRA_BODY),
      // One key per provider, so switching providers in Settings never sends one provider's key to another.
      keys: {
        google: env.GOOGLE_API_KEY || '',
        'nvidia-nim': env.NVIDIA_API_KEY || '',
        openrouter: env.OPENROUTER_API_KEY || '',
      },
      timeoutMs: (Number(env.AI_TIMEOUT_SECONDS) || 300) * 1000,
      // Left undefined, these come from the provider preset.
      chunkTokens: positiveInt(env.AI_CHUNK_TOKENS), // lesson tokens per AI call
      concurrency: positiveInt(env.AI_CONCURRENCY), // parallel AI calls within one pipeline stage
      keyTermsMax: positiveInt(env.KEY_TERMS_MAX), // key terms kept per lesson (default 12)
    },
  };
}
