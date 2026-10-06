// Provider presets. Every provider speaks the OpenAI-compatible /chat/completions API; a preset just fills in the
// base URL, a default model and how much lesson text / how many parallel calls suit it.
//
//   chunkTokens  lesson tokens per AI call (small local models have ~8k of context, hosted Gemini has far more)
//   concurrency  parallel calls within one pipeline stage (Google's free tier allows ~15 requests per minute)
//   keyEnv       the .env variable that holds this provider's API key (null: no key needed)
//   temperature  sampling temperature for the pipeline's calls (low: faithful to the lesson, steady JSON)
//   timeoutMs    how long one request may take before it is abandoned (and retried once)
//   jsonSchema   the endpoint accepts response_format: { type: 'json_schema' } (zod still validates every reply)
//   models       per-model tuning that replaces the preset's: { [model id]: { timeoutMs, requestsPerMinute, extraBody } },
//                where requestsPerMinute is a client-side limit on HTTP requests (retries included) to that model and
//                extraBody is merged into that model's requests (e.g. Gemma's reasoning_effort)
export const DEFAULT_PROVIDER = 'google';
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_TIMEOUT_MS = 300_000; // slow local and reasoning models need a long wait
const GOOGLE_TIMEOUT_MS = 60_000; // Gemini answers in seconds; a request still silent after a minute is stuck

// The last fallback for live calls (Explain simpler, Filipino/Taglish), on the admin's Google key. Never used for
// lesson processing.
export const GEMMA_MODEL = 'gemma-4-26b-a4b-it';

// Providers a student may use with their own key (Settings, when admin allows it).
export const STUDENT_PROVIDERS = ['google', 'deepseek', 'qwen', 'nvidia-nim', 'openrouter'];

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
    models: {
      // Normal calls take 1-4 s, so a request silent for 25 s is stuck; the free tier allows 15 requests a minute.
      'gemini-3.5-flash-lite': { timeoutMs: 25_000, requestsPerMinute: 15 },
      // The live calls' last fallback (GEMMA_MODEL). Without reasoning_effort "minimal" it thinks first (25-30 s, and the
      // thinking can use up max_tokens); with it, measured: Explain simpler 4.7-5.9 s, Taglish 9.4-12.0 s, so the 25 s
      // timeout fits. Its token limit (16K a minute) is the tight one, not requests: a call is roughly 1-2K tokens, so 8 a minute stays
      // inside it. Live calls send it only the section, capped.
      'gemma-4-26b-a4b-it': { timeoutMs: 25_000, requestsPerMinute: 8, extraBody: { reasoning_effort: 'minimal' } },
      // Slower (measured 33-50 s for the same rewrites), so not the fallback; tuned in case admin picks it as Default.
      'gemma-4-31b-it': { timeoutMs: 60_000, requestsPerMinute: 30, extraBody: { reasoning_effort: 'minimal' } },
    },
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
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    chunkTokens: 2_400,
    concurrency: 2,
    temperature: DEFAULT_TEMPERATURE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keyEnv: 'DEEPSEEK_API_KEY',
    needsKey: true,
    jsonSchema: false,
  },
  // Alibaba Cloud Model Studio (DashScope), international endpoint (Singapore region).
  qwen: {
    id: 'qwen',
    label: 'Qwen (Alibaba Cloud)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    chunkTokens: 2_400,
    concurrency: 2,
    temperature: DEFAULT_TEMPERATURE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keyEnv: 'DASHSCOPE_API_KEY',
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

// The tuning a preset gives one model: its `models` entry over the preset's own values.
// -> { timeoutMs, requestsPerMinute, extraBody }
export function modelTuning(provider, model) {
  const preset = PRESETS[provider];
  const own = preset?.models?.[bareModelId(model)] ?? {};
  return { timeoutMs: own.timeoutMs ?? preset?.timeoutMs, requestsPerMinute: own.requestsPerMinute ?? preset?.requestsPerMinute, extraBody: own.extraBody };
}

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
