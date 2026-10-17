import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../middleware/errors.js';
import { parseJsonReply } from './json.js';
import { chatModelIds } from './models.js';
import { createRateLimiter } from './ratelimit.js';

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
const MAX_RETRY_AFTER_MS = 60_000; // a provider asking for a longer wait gets this one (then the next attempt)
const MAX_TOKENS_CEILING = 16_000; // upper bound when a cut-off reply is retried with a bigger budget
// Lesson processing can ask for thinking (`reasoning: 'high'`, see chat()). The model's thinking tokens count against
// max_tokens and take seconds, so a thinking call gets more room and a longer wait than the model's usual tuning.
export const THINKING_HEADROOM_TOKENS = 8_000;
export const THINKING_TIMEOUT_MS = 120_000;
const THINKING_MAX_TOKENS = 32_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const LIVE_MAX_QUEUE_MS = 3_000; // a live call waits at most this long for the client-side request limit

export function normalizeBaseUrl(url) {
  return String(url ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|models)$/, '');
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The wait a 429 names, in ms, or null: the Retry-After header (seconds or an HTTP date), else the RetryInfo
// "retryDelay": "34s" that Google puts in the error body.
export function retryAfterMs(header, bodyText = '', now = Date.now()) {
  const value = String(header ?? '').trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  if (value) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(bodyText);
  return delay ? Math.round(Number(delay[1]) * 1000) : null;
}

// One onAttempt event as a log line: "the key terms #1 start", "the key terms #1 ok 1.9s",
// "the flashcards #1 FAIL timeout after 25.0s, retry in 2.0s", "the flashcards #2 waited 4.0s for the request limit".
export function describeAttempt(e) {
  const tag = `${e.label} #${e.attempt}${e.think ? ` (think=${e.think})` : ''}`;
  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  if (e.type === 'throttle') return `${tag} waited ${secs(e.waitMs)} for the request limit`;
  if (e.type === 'start') return `${tag} start`;
  if (e.type === 'ok') return `${tag} ok ${secs(e.ms)}`;
  const why = e.status ? `${e.reason} (HTTP ${e.status})` : e.reason;
  return `${tag} FAIL ${why} after ${secs(e.ms)}${e.retry ? `, retry in ${secs(e.waitMs)}` : ', giving up'}`;
}

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
  now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  onRetry = () => {}, // ({ reason, waitMs, attempt }) before each wait, e.g. for a progress log
  // every HTTP attempt: { type: 'throttle' | 'start' | 'ok' | 'fail', label, attempt, ms, status, reason, retry, waitMs }
  // reason (on 'fail'): timeout | rate_limit (429) | server (5xx) | network | http_<status> (not retried)
  onAttempt = () => {},
  log = console, // gets the provider's error body (keys redacted) when a request fails
} = {}) {
  // jsonRetries: replies re-asked because they were not valid JSON; httpRetries: requests repeated after a 429 / 5xx /
  // dropped connection; truncated: replies cut off by max_tokens; schemaSent / schemaRejected: requests that carried
  // response_format json_schema, and those the provider refused (then repeated without it). attempts: HTTP requests
  // sent; failedAttempts / retries: failed attempts and the ones retried, by reason (timeouts included);
  // throttledMs: time spent waiting for the client-side request limit.
  const stats = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    jsonRetries: 0,
    httpRetries: 0,
    truncated: 0,
    schemaSent: 0,
    schemaRejected: 0,
    attempts: 0,
    failedAttempts: {},
    retries: {},
    throttledMs: 0,
    // calls that asked for thinking, and the thinking tokens they used (the provider counts them in total_tokens only)
    thinkingCalls: 0,
    thinkingTokens: 0,
  };
  const limiter = createRateLimiter({ now, sleep });
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
      keyEnv: cfg.keyEnv ?? null,
      apiKey: cfg.apiKey || '',
      model: cfg.model || '',
      extraBody: cfg.extraBody && typeof cfg.extraBody === 'object' ? cfg.extraBody : undefined,
      jsonSchema: Boolean(cfg.jsonSchema),
      reasoningEffort: Boolean(cfg.reasoningEffort), // the endpoint accepts reasoning_effort (Google's does)
      temperature: typeof cfg.temperature === 'number' ? cfg.temperature : undefined,
      timeoutMs: cfg.timeoutMs > 0 ? cfg.timeoutMs : timeoutMs,
      requestsPerMinute: cfg.requestsPerMinute > 0 ? cfg.requestsPerMinute : 0,
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
    const keyHint = cfg.keyEnv ? ` (or ${cfg.keyEnv} in .env)` : '';
    let failure;
    // Google answers an invalid key with 400 "API key not valid" instead of 401, so a 400 is read before it is blamed on the model.
    if (s === 401 || s === 403 || (s === 400 && /valid api key|api[ _-]?key (?:not valid|is invalid|invalid|expired)|API_KEY_INVALID|invalid api key|incorrect api key|missing api key/i.test(body))) {
      failure = new AiError('auth', `The AI provider rejected the API key (HTTP ${s}). Check the API key in Settings${keyHint}.`);
    } else if (s === 404) {
      failure = new AiError('not_found', `The AI provider couldn't find that model or endpoint (HTTP 404). Check the model in Settings, and the base URL if you use a custom one.`);
    } else if (s === 402) {
      failure = new AiError('no_credit', `The AI provider says this account has no credit left (HTTP 402). Check the account's balance or plan.`);
    } else if (s === 429) {
      failure = new AiError('rate_limit', `The AI provider is rate limiting requests (HTTP 429). Try again shortly.`);
    } else if (s >= 500) {
      failure = new AiError('provider_error', `The AI provider had a problem (HTTP ${s}). Try again in a moment.`);
    } else {
      const tooLong = /context|token|too long|maximum/i.test(detail) ? " If the model's context window is too small, pick one with a larger window." : '';
      failure = new AiError('bad_request', `The AI provider rejected the request (HTTP ${s}). Check the model in Settings.${tooLong}`);
    }
    failure.detail = detail;
    failure.body = body; // redacted; lets a caller tell a used-up quota from a per-minute limit
    failure.providerStatus = s;
    return failure;
  }

  function describeNetworkError(err, cfg) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return new AiError('timeout', `The AI provider is slow: it didn't answer within ${Math.round(cfg.timeoutMs / 1000)} seconds. Retry, or pick a faster model in Settings.`, 504);
    }
    const code = err?.cause?.code ?? err?.code;
    if (code === 'ECONNREFUSED') return new AiError('network', `Couldn't connect to the AI provider at ${cfg.host}. Is it running, and is the base URL right?`);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new AiError('network', `Couldn't find the AI provider's address (${cfg.host}). Check the base URL and your internet connection.`);
    return new AiError('network', `Couldn't reach the AI provider at ${cfg.host} (${redact(code ?? err?.message ?? 'network error', cfg.apiKey)}).`);
  }

  // One failed attempt: counted by reason, reported to onAttempt (and onRetry when it will be retried).
  function attemptFailed({ label, attempt, startedAt, reason, status, retry, waitMs, think }) {
    stats.failedAttempts[reason] = (stats.failedAttempts[reason] ?? 0) + 1;
    if (retry) {
      stats.httpRetries += 1;
      stats.retries[reason] = (stats.retries[reason] ?? 0) + 1;
      onRetry({ reason: status ? `HTTP ${status}` : reason, waitMs, attempt });
    }
    onAttempt({ type: 'fail', label, attempt, ms: now() - startedAt, reason, status, retry, waitMs: retry ? waitMs : 0, think });
  }

  // One HTTP exchange -> the parsed JSON reply. Rate limits (429), 5xx and dropped connections are retried after a
  // wait; a timeout is retried once. The reply body is read inside the attempt, under the same timeout, so a reply that
  // stalls halfway is a timeout like one that never starts. Each attempt first takes a slot from the client-side limit
  // (cfg.requestsPerMinute) and is reported to onAttempt: 'throttle' (waited for a slot), 'start', 'ok', 'fail'.
  // `live` (a student is waiting, and a fallback is ready): one attempt, no retry waits, and a request that would wait
  // more than LIVE_MAX_QUEUE_MS for the client-side limit fails at once as a rate limit without being sent.
  async function send(cfg, path, { method = 'GET', body, label = path, live = false, think } = {}) {
    const headers = { Accept: 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // per key too: a student's own key has its own quota, separate from the admin's
    const keyTag = cfg.apiKey ? createHash('sha256').update(cfg.apiKey).digest('hex').slice(0, 8) : '';
    const limitKey = `${cfg.host}|${cfg.model}|${keyTag}`;

    let timedOut = false; // a timeout is retried once: a stuck request often succeeds when sent again
    for (let attempt = 1; ; attempt++) {
      const canRetry = !live && attempt <= retryDelaysMs.length;
      const waitedMs = await limiter.acquire(limitKey, cfg.requestsPerMinute, live ? { maxWaitMs: LIVE_MAX_QUEUE_MS } : undefined);
      if (waitedMs === null) {
        stats.failedAttempts.rate_limit = (stats.failedAttempts.rate_limit ?? 0) + 1;
        onAttempt({ type: 'fail', label, attempt, ms: 0, reason: 'rate_limit', retry: false, waitMs: 0, local: true, think });
        throw new AiError('rate_limit', `Too many AI requests to ${cfg.model} right now (the app's own limit of ${cfg.requestsPerMinute} a minute). Try again shortly.`);
      }
      if (waitedMs) {
        stats.throttledMs += waitedMs;
        onAttempt({ type: 'throttle', label, attempt, waitMs: waitedMs, think });
      }
      stats.attempts += 1;
      const startedAt = now();
      onAttempt({ type: 'start', label, attempt, think });
      let res;
      let text;
      try {
        res = await fetchImpl(`${cfg.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (res.ok) text = await res.text();
      } catch (err) {
        const failure = describeNetworkError(err, cfg);
        // A refused/unknown host won't fix itself in seconds; a timeout already cost the full wait, so it gets one retry.
        const hopeless = /ECONNREFUSED|ENOTFOUND/.test(String(err?.cause?.code)) || (failure.code === 'timeout' && timedOut);
        const retry = canRetry && !hopeless;
        const waitMs = retry ? jitter(retryDelaysMs[attempt - 1]) : 0;
        attemptFailed({ label, attempt, startedAt, reason: failure.code, retry, waitMs, think });
        if (!retry) throw failure;
        if (failure.code === 'timeout') timedOut = true;
        await sleep(waitMs);
        continue;
      }
      if (res.ok) {
        onAttempt({ type: 'ok', label, attempt, ms: now() - startedAt, status: res.status, think });
        return parseReply(text, cfg);
      }
      if (canRetry && RETRYABLE_STATUS.has(res.status)) {
        const reason = res.status === 429 ? 'rate_limit' : 'server';
        const errorText = await res.text().catch(() => '');
        const named = reason === 'rate_limit' ? retryAfterMs(res.headers.get('retry-after'), errorText, now()) : null;
        const waitMs = jitter(named !== null ? Math.min(named, MAX_RETRY_AFTER_MS) : retryDelaysMs[attempt - 1]); // jitter only adds: Retry-After is still respected
        // Under a client-side limit, the provider's wait holds every call to this model, not just this one.
        if (named !== null && cfg.requestsPerMinute > 0) limiter.pause(limitKey, now() + waitMs);
        attemptFailed({ label, attempt, startedAt, reason, status: res.status, retry: true, waitMs, think });
        await sleep(waitMs);
        continue;
      }
      const reason = res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'server' : `http_${res.status}`;
      // A live call doesn't wait and retry, but a real 429 still tells every caller to this model when to come back
      // (the next live calls then go straight to the next step instead of each being refused by the provider).
      if (res.status === 429) {
        const named = retryAfterMs(res.headers.get('retry-after'), await res.clone().text().catch(() => ''), now());
        if (named !== null) limiter.pause(limitKey, now() + Math.min(named, MAX_RETRY_AFTER_MS));
      }
      attemptFailed({ label, attempt, startedAt, reason, status: res.status, retry: false, think });
      throw await describeFailure(res, cfg);
    }
  }

  function parseReply(text, cfg) {
    try {
      return JSON.parse(text);
    } catch {
      throw new AiError('bad_response', `The AI provider didn't return JSON. Is ${cfg.baseUrl} an OpenAI-compatible endpoint (it should end in /v1)?`);
    }
  }

  // One chat completion. Returns { content, finishReason }; content is '' when the model said nothing.
  // `responseSchema` ({ name, schema } as JSON Schema) is sent as response_format only to providers that support it;
  // if one turns out not to, the request is repeated without it and the host is remembered.
  // AI_EXTRA_BODY options are merged in, but can't replace the model or the messages.
  // `reasoning: 'high'` (lesson processing only) asks the model to think: reasoning_effort goes in the body after
  // AI_EXTRA_BODY, max_tokens grows by THINKING_HEADROOM_TOKENS (thinking counts against it) and the request may take
  // THINKING_TIMEOUT_MS. Ignored for a provider whose preset does not take reasoning_effort.
  async function chat({ messages, maxTokens = 4000, temperature, responseSchema, config, label, live = false, reasoning }) {
    const base = readConfig({ needModel: true }, config);
    const think = reasoning === 'high' && base.reasoningEffort ? 'high' : undefined;
    const cfg = think ? { ...base, timeoutMs: Math.max(base.timeoutMs, THINKING_TIMEOUT_MS) } : base;
    // sampling temperature: this call > the provider's setting (preset default 0.2); AI_EXTRA_BODY can still override it
    const body = {
      temperature: temperature ?? cfg.temperature ?? 0.2,
      max_tokens: think ? Math.min(maxTokens + THINKING_HEADROOM_TOKENS, THINKING_MAX_TOKENS) : maxTokens,
      stream: false,
      ...cfg.extraBody,
      ...(think ? { reasoning_effort: think } : {}),
      model: cfg.model,
      messages,
    };
    const useSchema = Boolean(responseSchema) && cfg.jsonSchema && !noJsonSchema.has(cfg.host);
    let data;
    if (useSchema) {
      const withFormat = { ...body, response_format: { type: 'json_schema', json_schema: { name: responseSchema.name, schema: responseSchema.schema } } };
      try {
        stats.schemaSent += 1;
        data = await send(cfg, '/chat/completions', { method: 'POST', body: withFormat, label, live, think });
      } catch (err) {
        if (err.code !== 'bad_request') throw err;
        stats.schemaRejected += 1;
        data = await send(cfg, '/chat/completions', { method: 'POST', body, label, live, think });
        noJsonSchema.add(cfg.host); // the same request works without response_format, so that was the problem
      }
    }
    data ??= await send(cfg, '/chat/completions', { method: 'POST', body, label, live, think });
    const choice = data?.choices?.[0];
    if (!choice) throw new AiError('bad_response', "The AI provider's reply had no answer in it. Check that the model name is a chat model.");
    stats.calls += 1;
    stats.promptTokens += data.usage?.prompt_tokens ?? 0;
    stats.completionTokens += data.usage?.completion_tokens ?? 0;
    if (think) {
      stats.thinkingCalls += 1;
      const u = data.usage ?? {};
      stats.thinkingTokens += Math.max(0, (u.total_tokens ?? 0) - (u.prompt_tokens ?? 0) - (u.completion_tokens ?? 0));
    }
    const raw = choice.message?.content;
    const content = Array.isArray(raw) ? raw.map((p) => p?.text ?? '').join('') : (raw ?? '');
    return { content, finishReason: choice.finish_reason ?? null };
  }

  // Asks for JSON, validates it with `schema` (zod) and returns the parsed value. An unparseable or invalid reply is
  // retried once, telling the model what was wrong; provider/HTTP failures are not retried here (see send()).
  // A reply cut off by the token limit is retried with double the budget: reasoning models spend max_tokens on
  // thinking before they write any JSON, so the same limit would just fail again.
  // `live`: see send(). The one retry for an unusable reply still applies.
  async function generateJSON({ system, user, schema, responseSchema, maxTokens, temperature, label = 'this request', config, live = false, reasoning }) {
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
        label,
        live,
        reasoning,
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

  // Tiny round-trip proving URL, key, model and JSON output all work. `live`: one attempt, no retry waits (a student's
  // "Test key" answers at once).
  async function testConnection(config, { live = false } = {}) {
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
      live,
    });
    return { ok: true, model: cfg.model, latencyMs: Date.now() - started, reply };
  }

  // Chat-capable model ids from {baseUrl}/models, sorted, without a "models/" prefix. [] when the provider lists none
  // (the caller then offers a free-text model id).
  async function listModels(config, { live = false } = {}) {
    const cfg = readConfig({ needModel: false }, config);
    return chatModelIds(await send(cfg, '/models', { label: 'the model list', live }));
  }

  return { chat, generateJSON, testConnection, listModels, stats };
}
