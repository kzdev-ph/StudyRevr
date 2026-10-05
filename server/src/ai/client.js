import { z } from 'zod';
import { HttpError } from '../middleware/errors.js';
import { parseJsonReply } from './json.js';
import { chatModelIds } from './models.js';

// Failures talking to the AI provider. `message` is written for the student/teacher to read; `code` is for code.
// It is an HttpError so a route can let it propagate and get a JSON error with the right status.
export class AiError extends HttpError {
  constructor(code, message, status = 502) {
    super(status, message, { code });
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 6_000]; // waits before the 2nd and 3rd HTTP attempt (429 / 5xx / network)
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_TOKENS_CEILING = 16_000; // upper bound when a cut-off reply is retried with a bigger budget
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function normalizeBaseUrl(url) {
  return String(url ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|models)$/, '');
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const issueSummary = (error) =>
  error.issues
    .slice(0, 4)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');

// OpenAI-compatible client (NVIDIA NIM, Ollama /v1, llama.cpp server, OpenRouter, ...). `getConfig` is called per
// request so changes saved in Settings apply without a restart: () => ({ baseUrl, apiKey, model }).
export function createAiClient({
  getConfig,
  fetchImpl = globalThis.fetch,
  sleep = sleepMs,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
} = {}) {
  const stats = { calls: 0, promptTokens: 0, completionTokens: 0 };

  function readConfig({ needModel }) {
    const cfg = getConfig();
    const baseUrl = normalizeBaseUrl(cfg.baseUrl);
    if (!baseUrl || (needModel && !cfg.model)) {
      throw new AiError(
        'not_configured',
        "The AI provider isn't set up yet. Add AI_BASE_URL, AI_API_KEY and AI_MODEL to .env, or enter them in Settings.",
        400,
      );
    }
    let host;
    try {
      host = new URL(baseUrl).host;
    } catch {
      throw new AiError('not_configured', `The AI base URL "${baseUrl}" isn't a valid URL. It should look like https://host/v1.`, 400);
    }
    return { baseUrl, host, apiKey: cfg.apiKey || '', model: cfg.model || '' };
  }

  // Keeps the key out of anything we show or log, even if a provider echoes it back.
  const redact = (text, apiKey) => (apiKey ? String(text).split(apiKey).join('***') : String(text));

  async function describeFailure(res, cfg) {
    let detail = '';
    try {
      const text = await res.text();
      try {
        const body = JSON.parse(text);
        detail = body?.error?.message ?? body?.detail ?? body?.message ?? (typeof body?.error === 'string' ? body.error : '');
        if (typeof detail !== 'string') detail = JSON.stringify(detail);
      } catch {
        detail = text;
      }
    } catch {
      // no readable body
    }
    detail = redact(detail, cfg.apiKey).replace(/\s+/g, ' ').trim().slice(0, 300);
    const suffix = detail ? ` Provider said: ${detail}` : '';
    const s = res.status;
    if (s === 401 || s === 403) return new AiError('auth', `The AI provider rejected the API key (HTTP ${s}). Check the key in Settings or .env.${suffix}`);
    if (s === 404) return new AiError('not_found', `The AI provider couldn't find that endpoint or model (HTTP 404). Check the base URL and model name.${suffix}`);
    if (s === 429) return new AiError('rate_limit', `The AI provider is rate-limiting requests (HTTP 429). Wait a minute, then try again.${suffix}`);
    if (s >= 500) return new AiError('provider_error', `The AI provider had a problem (HTTP ${s}). Try again in a moment.${suffix}`);
    const tooLong = /context|token|too long|maximum/i.test(detail) ? " The model's context window may be too small; try a model with a larger one." : '';
    return new AiError('bad_request', `The AI provider rejected the request (HTTP ${s}).${tooLong}${suffix}`);
  }

  function describeNetworkError(err, cfg) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return new AiError('timeout', `The AI provider didn't answer within ${Math.round(timeoutMs / 1000)} seconds. It may be overloaded or the model too slow.`, 504);
    }
    const code = err?.cause?.code ?? err?.code;
    if (code === 'ECONNREFUSED') return new AiError('network', `Couldn't connect to the AI provider at ${cfg.host}. Is it running, and is the base URL right?`);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new AiError('network', `Couldn't find the AI provider's address (${cfg.host}). Check the base URL and your internet connection.`);
    return new AiError('network', `Couldn't reach the AI provider at ${cfg.host} (${redact(code ?? err?.message ?? 'network error', cfg.apiKey)}).`);
  }

  // One HTTP exchange, retrying rate limits, 5xx and dropped connections with a short wait.
  async function send(cfg, path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < retryDelaysMs.length;
      let res;
      try {
        res = await fetchImpl(`${cfg.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const failure = describeNetworkError(err, cfg);
        // A timeout already cost the full wait, and a refused/unknown host won't fix itself in seconds.
        const hopeless = failure.code === 'timeout' || /ECONNREFUSED|ENOTFOUND/.test(String(err?.cause?.code));
        if (!canRetry || hopeless) throw failure;
        await sleep(retryDelaysMs[attempt]);
        continue;
      }
      if (res.ok) return res;
      if (canRetry && RETRYABLE_STATUS.has(res.status)) {
        const retryAfter = Number(res.headers.get('retry-after'));
        res.body?.cancel().catch(() => {}); // free the connection; no need to wait for it
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : retryDelaysMs[attempt]);
        continue;
      }
      throw await describeFailure(res, cfg);
    }
  }

  async function readJson(res, cfg) {
    try {
      return await res.json();
    } catch {
      throw new AiError('bad_response', `The AI provider didn't return JSON. Is ${cfg.baseUrl} an OpenAI-compatible endpoint (it should end in /v1)?`);
    }
  }

  // One chat completion. Returns { content, finishReason }; content is '' when the model said nothing.
  async function chat({ messages, maxTokens = 4000, temperature = 0.2 }) {
    const cfg = readConfig({ needModel: true });
    const res = await send(cfg, '/chat/completions', {
      method: 'POST',
      body: { model: cfg.model, messages, temperature, max_tokens: maxTokens, stream: false },
    });
    const data = await readJson(res, cfg);
    const choice = data?.choices?.[0];
    if (!choice) throw new AiError('bad_response', "The AI provider's reply had no answer in it. Check that the model name is a chat model.");
    stats.calls += 1;
    stats.promptTokens += data.usage?.prompt_tokens ?? 0;
    stats.completionTokens += data.usage?.completion_tokens ?? 0;
    const raw = choice.message?.content;
    const content = Array.isArray(raw) ? raw.map((p) => p?.text ?? '').join('') : (raw ?? '');
    return { content, finishReason: choice.finish_reason ?? null };
  }

  // Asks for JSON, validates it with `schema` (zod) and returns the parsed value. An unparseable or invalid reply is
  // retried once, telling the model what was wrong; provider/HTTP failures are not retried here (see send()).
  // A reply cut off by the token limit is retried with double the budget: reasoning models spend max_tokens on
  // thinking before they write any JSON, so the same limit would just fail again.
  async function generateJSON({ system, user, schema, maxTokens, temperature, label = 'this request' }) {
    let problem = '';
    let budget = maxTokens;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const retryNote =
        attempt === 1 ? '' : `\n\nYour previous reply was rejected: ${problem} Reply again with ONLY one valid JSON object in the requested format.`;
      const { content, finishReason } = await chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user + retryNote },
        ],
        maxTokens: budget,
        temperature,
      });
      if (finishReason === 'length' && budget) budget = Math.min(budget * 2, MAX_TOKENS_CEILING);
      const cutOff = finishReason === 'length' ? ' It was cut off for being too long, so keep it shorter.' : '';
      let value;
      try {
        value = parseJsonReply(content);
      } catch (err) {
        problem = `it was not valid JSON (${err.message}).${cutOff}`;
        continue;
      }
      const parsed = schema.safeParse(value);
      if (parsed.success) return parsed.data;
      problem = `it did not match the required format (${issueSummary(parsed.error)}).${cutOff}`;
    }
    throw new AiError(
      'invalid_json',
      `The AI model didn't return usable JSON for ${label} after 2 tries: ${problem} Try again, or choose a more capable model in Settings.`,
    );
  }

  const connectionTestSchema = z.object({ ok: z.literal(true), word: z.string().min(1) });

  // Tiny round-trip proving URL, key, model and JSON output all work.
  async function testConnection() {
    const cfg = readConfig({ needModel: true });
    const started = Date.now();
    const reply = await generateJSON({
      system: 'You are a connection test. Reply with a single JSON object and nothing else: no markdown, no code fences.',
      user: 'Reply with exactly this JSON object: {"ok": true, "word": "pong"}',
      schema: connectionTestSchema,
      maxTokens: 1024,
      label: 'the connection test',
    });
    return { ok: true, model: cfg.model, latencyMs: Date.now() - started, reply };
  }

  // Chat-capable model ids from {baseUrl}/models, sorted.
  async function listModels() {
    const cfg = readConfig({ needModel: false });
    const res = await send(cfg, '/models');
    const ids = chatModelIds(await readJson(res, cfg));
    if (!ids.length) throw new AiError('bad_response', 'The AI provider returned no chat models. Check the base URL.');
    return ids;
  }

  return { chat, generateJSON, testConnection, listModels, stats };
}
