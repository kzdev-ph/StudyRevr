import { z } from 'zod';
import { HttpError } from '../middleware/errors.js';
import { parseJsonReply } from './json.js';
import { chatModelIds } from './models.js';

// Failures talking to the AI provider. `message` is plain language for the student/teacher: what happened and what to
// do, with no status codes (those go to the server log). `hint` is for whoever runs the server (which .env variable to
// set); the UI shows it behind a collapsed "Details" toggle. `code` is for code.
// TODO(Phase 7): once Settings has the key / model / URL fields, the hints should point there instead of .env.
// It is an HttpError so a route can let it propagate and get a JSON error with the right status.
export class AiError extends HttpError {
  constructor(code, message, status = 502, hint = undefined) {
    super(status, message, hint ? { code, hint } : { code });
    this.code = code;
    this.hint = hint;
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
  log = console, // gets the provider's error body (keys redacted) when a request fails
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
        `No API key is set for ${cfg.label ?? 'the AI provider'} yet. Add the key, then retry.`,
        400,
        `Add ${cfg.keyEnv ?? 'AI_API_KEY'} to the .env file and restart the server.`,
      );
    }
    if (!baseUrl || (needModel && !cfg.model)) {
      throw new AiError(
        'not_configured',
        "The AI provider isn't set up yet. Choose a provider and model, then retry.",
        400,
        'Set AI_PROVIDER and its API key (and AI_MODEL for a custom provider) in the .env file and restart the server.',
      );
    }
    let host;
    try {
      host = new URL(baseUrl).host;
    } catch {
      throw new AiError('not_configured', "The AI base URL isn't a valid web address. Fix it, then retry.", 400, `"${baseUrl}" should look like https://host/v1. Set AI_BASE_URL in the .env file and restart the server.`);
    }
    return {
      baseUrl,
      host,
      keyEnv: cfg.keyEnv ?? null,
      apiKey: cfg.apiKey || '',
      model: cfg.model || '',
      extraBody: cfg.extraBody && typeof cfg.extraBody === 'object' ? cfg.extraBody : undefined,
      jsonSchema: Boolean(cfg.jsonSchema),
      temperature: typeof cfg.temperature === 'number' ? cfg.temperature : undefined,
      timeoutMs: cfg.timeoutMs > 0 ? cfg.timeoutMs : timeoutMs,
    };
  }

  // Keeps keys out of anything we show or log: the configured key exactly, and the shapes keys take when a provider
  // echoes one back (a Bearer header, Google AIza..., sk-..., nvapi-..., key=... in a URL).
  const redact = (text, apiKey) => {
    let out = String(text);
    if (apiKey) out = out.split(apiKey).join('***');
    return out
      .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer ***')
      .replace(/\b(?:AIza|sk-|nvapi-)[\w-]{8,}/g, '***')
      .replace(/\b(api[_-]?key|key|token)=[^\s&"']+/gi, '$1=***');
  };

  // The provider's error text, redacted, on one line. `detail` is the short readable reason, `body` is everything it
  // sent (for the server log).
  async function readFailureBody(res, cfg) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      // no readable body
    }
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message ?? parsed?.[0]?.error?.message ?? parsed?.detail ?? parsed?.message ?? (typeof parsed?.error === 'string' ? parsed.error : text);
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch {
      // not JSON: the plain text is the detail
    }
    const oneLine = (s) => redact(s, cfg.apiKey).replace(/\s+/g, ' ').trim();
    return { detail: oneLine(detail).slice(0, 300), body: oneLine(text).slice(0, 2000) };
  }

  // Messages tell the person what to change. The provider's own wording goes to the server log, not to the screen.
  async function describeFailure(res, cfg) {
    const { detail, body } = await readFailureBody(res, cfg);
    const s = res.status;
    log.warn?.(`[ai] ${cfg.host} answered HTTP ${s} for model "${cfg.model || '(none)'}": ${body || '(empty body)'}`);
    const keyEnv = cfg.keyEnv ?? 'AI_API_KEY';
    let failure;
    // Google answers an invalid key with 400 "API key not valid" instead of 401, so a 400 is read before it is blamed on the model.
    if (s === 401 || s === 403 || (s === 400 && /valid api key|api[ _-]?key (?:not valid|is invalid|invalid|expired)|API_KEY_INVALID|invalid api key|incorrect api key|missing api key/i.test(body))) {
      failure = new AiError('auth', 'The AI provider rejected the API key. Check the key, then retry.', 502, `Set ${keyEnv} in the .env file to a valid key and restart the server.`);
    } else if (s === 404) {
      failure = new AiError('not_found', "The AI provider couldn't find that model or address. Check the model name, then retry.", 502, 'Set AI_MODEL in the .env file, and AI_BASE_URL if you use a custom provider, then restart the server.');
    } else if (s === 429) {
      failure = new AiError('rate_limit', 'The AI provider is rate limiting requests. Try again shortly.');
    } else if (s >= 500) {
      failure = new AiError('provider_error', 'The AI provider had a problem. Try again in a moment.');
    } else {
      const tooLong = /context|token|too long|maximum/i.test(detail) ? " If the model's context window is too small, pick one with a larger window." : '';
      failure = new AiError('bad_request', `The AI provider rejected the request. Check the model, then retry.${tooLong}`, 502, 'Set AI_MODEL in the .env file to a chat model and restart the server.');
    }
    failure.detail = detail;
    return failure;
  }

  function describeNetworkError(err, cfg) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return new AiError('timeout', `The AI provider is slow: it didn't answer within ${Math.round(cfg.timeoutMs / 1000)} seconds. Retry, or use a faster model.`, 504, 'Set AI_MODEL in the .env file to a faster model, or raise AI_TIMEOUT_SECONDS, and restart the server.');
    }
    const code = err?.cause?.code ?? err?.code;
    if (code === 'ECONNREFUSED') return new AiError('network', `Couldn't connect to the AI provider at ${cfg.host}. Is it running?`, 502, 'Check AI_BASE_URL in the .env file.');
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new AiError('network', `Couldn't find the AI provider's address (${cfg.host}). Check your internet connection, then retry.`, 502, 'If you use a custom provider, check AI_BASE_URL in the .env file.');
    return new AiError('network', `Couldn't reach the AI provider at ${cfg.host}. Check your connection, then retry.`, 502, `Network error: ${redact(code ?? err?.message ?? 'unknown', cfg.apiKey)}`);
  }

  // One HTTP exchange, retrying rate limits, 5xx and dropped connections with a short wait.
  async function send(cfg, path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let timedOut = false; // a timeout is retried once: a stuck request often succeeds when sent again
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < retryDelaysMs.length;
      let res;
      try {
        res = await fetchImpl(`${cfg.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (err) {
        const failure = describeNetworkError(err, cfg);
        // A refused/unknown host won't fix itself in seconds; a timeout already cost the full wait, so it gets one retry.
        const hopeless = /ECONNREFUSED|ENOTFOUND/.test(String(err?.cause?.code)) || (failure.code === 'timeout' && timedOut);
        if (!canRetry || hopeless) throw failure;
        if (failure.code === 'timeout') timedOut = true;
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
      throw new AiError('bad_response', "The AI provider didn't return JSON. Check the provider's web address, then retry.", 502, `Is ${cfg.baseUrl} an OpenAI-compatible endpoint? It should end in /v1. Set AI_BASE_URL in the .env file.`);
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
    if (!choice) throw new AiError('bad_response', "The AI provider's reply had no answer in it. Check that the model is a chat model, then retry.", 502, 'Set AI_MODEL in the .env file to a chat model and restart the server.');
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
      `The AI model didn't return usable JSON for ${label} after 2 tries: ${problem} Try again, or use a more capable model.`,
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
