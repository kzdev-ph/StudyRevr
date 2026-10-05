// Provider presets. Every provider speaks the OpenAI-compatible /chat/completions API; a preset just fills in the
// base URL, a default model and how much lesson text / how many parallel calls suit it.
//
//   chunkTokens  lesson tokens per AI call (small local models have ~8k of context, hosted Gemini has far more)
//   concurrency  parallel calls within one pipeline stage (Google's free tier allows ~15 requests per minute)
//   keyEnv       the .env variable that holds this provider's API key (null: no key needed)
//   temperature  sampling temperature for the pipeline's calls (low: faithful to the lesson, steady JSON)
//   timeoutMs    how long one request may take before it is abandoned (and retried once)
//   jsonSchema   the endpoint accepts response_format: { type: 'json_schema' } (zod still validates every reply)
export const DEFAULT_PROVIDER = 'google';
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_TIMEOUT_MS = 300_000; // slow local and reasoning models need a long wait
const GOOGLE_TIMEOUT_MS = 60_000; // Gemini answers in seconds; a request still silent after a minute is stuck

// A sampling temperature from 0 to 2 (the range OpenAI-compatible APIs accept); anything else is undefined.
export const parseTemperature = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : undefined;
};

export const PRESETS = {
  google: {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.5-flash-lite',
    chunkTokens: 30_000,
    concurrency: 2,
    temperature: DEFAULT_TEMPERATURE,
    timeoutMs: GOOGLE_TIMEOUT_MS,
    keyEnv: 'GOOGLE_API_KEY',
    needsKey: true,
    jsonSchema: true,
  },
  'nvidia-nim': {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'deepseek-ai/deepseek-v4.1-flash',
    chunkTokens: 2_400,
    concurrency: 2,
    temperature: DEFAULT_TEMPERATURE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keyEnv: 'NVIDIA_API_KEY',
    needsKey: true,
    jsonSchema: false,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    chunkTokens: 2_400,
    concurrency: 2,
    temperature: DEFAULT_TEMPERATURE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keyEnv: 'OPENROUTER_API_KEY',
    needsKey: true,
    jsonSchema: false,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1:8b',
    chunkTokens: 2_400,
    concurrency: 1,
    temperature: DEFAULT_TEMPERATURE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keyEnv: null,
    needsKey: false,
    jsonSchema: false,
  },
  llamacpp: {
    id: 'llamacpp',
    label: 'llama.cpp server (local)',
    baseUrl: 'http://localhost:8080/v1',
    model: 'local',
    chunkTokens: 2_400,
    concurrency: 1,
    temperature: DEFAULT_TEMPERATURE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keyEnv: null,
    needsKey: false,
    jsonSchema: false,
  },
  // Anything else OpenAI-compatible: the base URL (and usually the model) must come from .env or Settings.
  custom: {
    id: 'custom',
    label: 'Custom',
    baseUrl: '',
    model: '',
    chunkTokens: 2_400,
    concurrency: 1,
    temperature: DEFAULT_TEMPERATURE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keyEnv: 'AI_API_KEY',
    needsKey: false,
    jsonSchema: false,
  },
};

// Gemini's /models lists ids as "models/gemini-..."; the chat endpoint wants the bare id.
export const bareModelId = (id) => String(id ?? '').trim().replace(/^models\//, '');

export const PROVIDER_IDS = Object.keys(PRESETS);
export const isProviderId = (id) => typeof id === 'string' && Object.hasOwn(PRESETS, id);

const hostOf = (url) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
};

// An older .env sets only AI_BASE_URL (no AI_PROVIDER): recognise a known provider by its host, else treat it as custom.
export function inferProvider(baseUrl) {
  const host = hostOf(baseUrl);
  if (!host) return null;
  return PROVIDER_IDS.find((id) => PRESETS[id].baseUrl && hostOf(PRESETS[id].baseUrl) === host) ?? 'custom';
}
