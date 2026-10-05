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
// Waits before the 2nd..5th HTTP attempt (429 / 5xx / network). Hosted providers like NIM answer 503 "overloaded" in
// bursts that last tens of seconds, so the later waits are long.
const DEFAULT_RETRY_DELAYS_MS = [2_000, 6_000, 15_000, 30_000];
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
  random = Math.random,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  onRetry = () => {}, // ({ reason, waitMs, attempt }) before each wait, e.g. for a progress log
} = {}) {
  // jsonRetries: replies re-asked because they were not valid JSON; httpRetries: requests repeated after a 429 / 5xx /
  // dropped connection; truncated: replies cut off by max_tokens; schemaSent / schemaRejected: requests that carried
  // response_format json_schema, and those the provider refused (then repeated without it).
  const stats = { calls: 0, promptTokens: 0, completionTokens: 0, jsonRetries: 0, httpRetries: 0, truncated: 0, schemaSent: 0, schemaRejected: 0 };
  const noJsonSchema = new Set(); // hosts that rejected response_format; not sent there again

  // Randomizes a wait by up to +25% so parallel calls that were rate-limited together don't retry in lockstep.
  const jitter = (ms) => Math.round(ms + ms * 0.25 * random());

  // `override` (a full config object) replaces getConfig() for one call, e.g. to test a provider before saving it.
  function readConfig({ needModel }, override) {
    const cfg = override ?? getConfig();
    const baseUrl = normalizeBaseUrl(cfg.baseUrl);
    if (cfg.needsKey && !cfg.apiKey) {
      throw new AiError(
        'not_configured',
        `No API key for ${cfg.label ?? 'the AI provider'} yet. Add ${cfg.keyEnv ?? 'AI_API_KEY'} to .env, or enter the key in Settings.`,
        400,
      );
    }
    if (!baseUrl || (needModel && !cfg.model)) {
      throw new AiError(
        'not_configured',
        "The AI provider isn't set up yet. Pick a provider and model in Settings, or set AI_PROVIDER and its API key in .env.",
        400,
      );
    }
    let host;
    try {
      host = new URL(baseUrl).host;
    } catch {
      throw new AiError('not_configured', `The AI base URL "${baseUrl}" isn't a valid URL. It should look like https://host/v1.`, 400);
    }
    return {
      baseUrl,
      host,
      apiKey: cfg.apiKey || '',
      model: cfg.model || '',
      extraBody: cfg.extraBody && typeof cfg.extraBody === 'object' ? cfg.extraBody : undefined,
      jsonSchema: Boolean(cfg.jsonSchema),
      temperature: typeof cfg.temperature === 'number' ? cfg.temperature : undefined,
    };
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
        const waitMs = jitter(retryDelaysMs[attempt]);
        stats.httpRetries += 1;
        onRetry({ reason: failure.code, waitMs, attempt: attempt + 1 });
        await sleep(waitMs);
        continue;
      }
      if (res.ok) return res;
      if (canRetry && RETRYABLE_STATUS.has(res.status)) {
        const retryAfter = Number(res.headers.get('retry-after'));
        res.body?.cancel().catch(() => {}); // free the connection; no need to wait for it
        const waitMs = jitter(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : retryDelaysMs[attempt]);
        stats.httpRetries += 1;
        onRetry({ reason: `HTTP ${res.status}`, waitMs, attempt: attempt + 1 });
        await sleep(waitMs);
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
  // `responseSchema` ({ name, schema } as JSON Schema) is sent as response_format only to providers that support it;
  // if one turns out not to, the request is repeated without it and the host is remembered.
  // AI_EXTRA_BODY options are merged in, but can't replace the model or the messages.
  async function chat({ messages, maxTokens = 4000, temperature, responseSchema, config }) {
    const cfg = readConfig({ needModel: true }, config);
    // sampling temperature: this call > the provider's setting (preset default 0.2); AI_EXTRA_BODY can still override it
    const body = { temperature: temperature ?? cfg.temperature ?? 0.2, max_tokens: maxTokens, stream: false, ...cfg.extraBody, model: cfg.model, messages };
    const useSchema = Boolean(responseSchema) && cfg.jsonSchema && !noJsonSchema.has(cfg.host);
    let res;
    if (useSchema) {
      const withFormat = { ...body, response_format: { type: 'json_schema', json_schema: { name: responseSchema.name, schema: responseSchema.schema } } };
      try {
        stats.schemaSent += 1;
        res = await send(cfg, '/chat/completions', { method: 'POST', body: withFormat });
      } catch (err) {
        if (err.code !== 'bad_request') throw err;
        stats.schemaRejected += 1;
        res = await send(cfg, '/chat/completions', { method: 'POST', body });
        noJsonSchema.add(cfg.host); // the same request works without response_format, so that was the problem
      }
    }
    res ??= await send(cfg, '/chat/completions', { method: 'POST', body });
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
  async function generateJSON({ system, user, schema, responseSchema, maxTokens, temperature, label = 'this request', config }) {
    let problem = '';
    let budget = maxTokens;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) stats.jsonRetries += 1;
      const retryNote =
        attempt === 1 ? '' : `\n\nYour previous reply was rejected: ${problem} Reply again with ONLY one valid JSON object in the requested format.`;
      const { content, finishReason } = await chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user + retryNote },
        ],
        maxTokens: budget,
        temperature,
        responseSchema,
        config,
      });
      if (finishReason === 'length') stats.truncated += 1;
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
  async function testConnection(config) {
    const cfg = readConfig({ needModel: true }, config);
    const started = Date.now();
    const reply = await generateJSON({
      system: 'You are a connection test. Reply with a single JSON object and nothing else: no markdown, no code fences.',
      user: 'Reply with exactly this JSON object: {"ok": true, "word": "pong"}',
      schema: connectionTestSchema,
      responseSchema: {
        name: 'connection_test',
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, word: { type: 'string' } }, required: ['ok', 'word'] },
      },
      maxTokens: 1024,
      label: 'the connection test',
      config,
    });
    return { ok: true, model: cfg.model, latencyMs: Date.now() - started, reply };
  }

  // Chat-capable model ids from {baseUrl}/models, sorted, without a "models/" prefix. [] when the provider lists none
  // (the caller then offers a free-text model id).
  async function listModels(config) {
    const cfg = readConfig({ needModel: false }, config);
    const res = await send(cfg, '/models');
    return chatModelIds(await readJson(res, cfg));
  }

  return { chat, generateJSON, testConnection, listModels, stats };
}
