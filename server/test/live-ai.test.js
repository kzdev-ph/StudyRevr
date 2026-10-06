import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AiError, createAiClient } from '../src/ai/client.js';
import { parseJsonReply } from '../src/ai/json.js';
import { fallbackNote, OUTAGE, runChain, STUDENT_FALLBACK } from '../src/ai/live.js';
import { chatModelIds } from '../src/ai/models.js';
import { GEMMA_MODEL, PRESETS } from '../src/ai/providers.js';
import { createRateLimiter } from '../src/ai/ratelimit.js';
import { loadConfig } from '../src/config.js';
import { exportCsv } from '../src/export/research.js';
import { runPipeline } from '../src/pipeline/run.js';
import { queueJob } from '../src/pipeline/jobs.js';
import { resolveAiConfig } from '../src/services/settings.js';
import { keyProblemMessage } from '../src/services/student-ai.js';
import { addCodes, completion, failure, KEY, makeClient, schema, scriptedFetch, TEST_PIN } from './helpers.js';

const quiet = { warn() {}, log() {}, info() {}, error() {} };
const STUDENT_KEY = 'sk-student-key-9876';
const simpleJson = (text = 'Simple words.') => JSON.stringify({ simple: text, example: 'Like a lunch line.' });
const bodyOf = (init) => JSON.parse(init.body);

describe('runChain and the fallback note', () => {
  const step = (source, outcome, fallbackOn = OUTAGE) => ({
    source,
    provider: 'p',
    model: source,
    fallbackOn,
    run: async () => {
      if (typeof outcome === 'string') throw new AiError(outcome, outcome);
      return outcome;
    },
  });

  it('falls back on outages and stops on anything else', async () => {
    const ok = await runChain([step('default', 'rate_limit'), step('gemma', { v: 1 })]);
    assert.deepEqual([ok.ok, ok.value, ok.step.source, ok.steps], [true, { v: 1 }, 'gemma', 1]);
    for (const code of ['timeout', 'network', 'provider_error']) assert.equal((await runChain([step('default', code), step('gemma', 1)])).ok, true, code);
    for (const code of ['bad_request', 'invalid_json', 'auth', 'no_credit']) {
      const r = await runChain([step('default', code), step('gemma', 1)]);
      assert.deepEqual([r.ok, r.error.code, r.failures.length], [false, code, 1], code);
    }
  });

  it('only the student step also falls back on a rejected key or no credit', async () => {
    for (const code of ['auth', 'no_credit']) {
      const r = await runChain([step('student', code, STUDENT_FALLBACK), step('default', { v: 1 })]);
      assert.deepEqual([r.ok, r.step.source], [true, 'default'], code);
    }
    const stop = await runChain([step('student', 'bad_request', STUDENT_FALLBACK), step('default', { v: 1 })]);
    assert.equal(stop.ok, false, 'a bad request does not fall back');
  });

  it('writes the note only when a fallback answered', () => {
    assert.equal(fallbackNote({ source: 'default', failures: [] }), null);
    assert.equal(fallbackNote({ source: 'default', failures: [{ source: 'student' }] }), 'Your key didn’t work, so the default AI answered.');
    assert.equal(fallbackNote({ source: 'gemma', failures: [{ source: 'default' }] }), 'The main AI was busy, so a backup AI answered.');
    assert.equal(
      fallbackNote({ source: 'gemma', failures: [{ source: 'student' }, { source: 'default' }] }),
      'Your key didn’t work and the main AI was busy, so a backup AI answered.',
    );
  });
});

describe('AI client: live calls', () => {
  it('a live call is one attempt: no retry waits on 429, 5xx, timeout or network errors', async () => {
    for (const step of [failure(429, { error: { message: 'slow down' } }), failure(503, 'overloaded'), () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }]) {
      const fetchImpl = scriptedFetch(step, completion('{"answer":"x","n":1}'));
      const ai = makeClient(fetchImpl, undefined, { log: quiet });
      await assert.rejects(ai.generateJSON({ system: 's', user: 'u', schema, live: true }), (err) => OUTAGE.has(err.code));
      assert.equal(fetchImpl.calls.length, 1);
      assert.deepEqual(ai.sleeps, []);
    }
    // the same failure outside live mode is retried
    const fetchImpl = scriptedFetch(failure(429, {}), completion('{"answer":"x","n":1}'));
    await makeClient(fetchImpl).generateJSON({ system: 's', user: 'u', schema });
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('a live call still gets the one retry for an unusable reply', async () => {
    const fetchImpl = scriptedFetch(completion('not json'), completion('{"answer":"x","n":1}'));
    assert.deepEqual(await makeClient(fetchImpl).generateJSON({ system: 's', user: 'u', schema, live: true }), { answer: 'x', n: 1 });
  });

  it('HTTP 402 is no_credit, and the provider body is kept (redacted) for telling quota from rate limits', async () => {
    const ai = makeClient(scriptedFetch(failure(402, { error: { message: `Insufficient Balance for ${'AIza-SECRET-KEY-123'}` } })), undefined, { log: quiet });
    await assert.rejects(ai.generateJSON({ system: 's', user: 'u', schema, live: true }), (err) => err.code === 'no_credit' && !err.body.includes(KEY) && /Insufficient/.test(err.body));
  });

  it('a live call that would wait for the request limit fails at once as a rate limit, without being sent', async () => {
    const cfg = { baseUrl: 'https://example.test/v1', apiKey: KEY, model: 'm', requestsPerMinute: 1 };
    const fetchImpl = scriptedFetch(completion('{"answer":"x","n":1}'));
    const ai = createAiClient({ getConfig: () => cfg, fetchImpl, sleep: async () => {}, now: () => 1_000_000, log: quiet });
    await ai.generateJSON({ system: 's', user: 'u', schema });
    await assert.rejects(ai.generateJSON({ system: 's', user: 'u', schema, live: true }), (err) => err.code === 'rate_limit');
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('the rate limiter keeps separate buckets per key', async () => {
    const limiter = createRateLimiter({ now: () => 0, sleep: async () => {} });
    assert.equal(await limiter.acquire('a', 1, { maxWaitMs: 0 }), 0);
    assert.equal(await limiter.acquire('a', 1, { maxWaitMs: 0 }), null);
    assert.equal(await limiter.acquire('b', 1, { maxWaitMs: 0 }), 0);
  });

  it("strips Gemma's <thought> block before reading the JSON", () => {
    assert.deepEqual(parseJsonReply('<thought>The user wants {"a":2}</thought>{"a":1}'), { a: 1 });
  });
});

describe('student key messages', () => {
  const err = (code, body = '') => Object.assign(new AiError(code, 'x'), { body });
  const msg = (e) => keyProblemMessage(e, 'DeepSeek').message;

  it('maps provider failures to the plain messages', () => {
    assert.equal(msg(err('auth')), 'The key was rejected. Check that you copied all of it.');
    assert.equal(msg(err('no_credit')), 'The key works but has no credit or quota left.');
    assert.equal(msg(err('rate_limit', 'Quota exceeded for metric ... quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier')), 'The key works but has no credit or quota left.');
    assert.equal(msg(err('rate_limit', 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-x')), 'The key works but has no credit or quota left.');
    // Google's per-minute limit also says "quota" and "billing": it is still "too many requests"
    assert.equal(
      msg(err('rate_limit', 'You exceeded your current quota, please check your plan and billing details. quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier, limit: 15')),
      'Too many requests right now. Try again in a minute.',
    );
    assert.equal(msg(err('not_found')), 'This model isn’t available with your key.');
    assert.equal(msg(err('bad_request')), 'This model isn’t available with your key.');
    assert.equal(msg(err('network')), 'Couldn’t reach DeepSeek. Check the internet connection.');
    assert.equal(msg(err('timeout')), 'Couldn’t reach DeepSeek. Check the internet connection.');
  });
});

describe('model picker filter', () => {
  it('hides aqa, research agents, antigravity, computer-use, image and media models', () => {
    const ids = ['gemini-3.5-flash-lite', 'gemma-4-26b-a4b-it', 'aqa', 'deep-research-pro-preview-12-2025', 'antigravity-preview-latest',
      'gemini-2.5-computer-use-preview-10-2025', 'nano-banana-pro-preview', 'gemini-3.1-flash-image', 'gemini-3.1-pro-preview-customtools',
      'gemini-omni-flash-preview', 'gemini-3.8-live', 'veo-3.1-generate-preview', 'qwen-plus', 'wan2.1-t2v-plus', 'cosyvoice-v1', 'deepseek-chat'];
    assert.deepEqual(chatModelIds({ data: ids.map((id) => ({ id: `models/${id}` })) }), ['deepseek-chat', 'gemini-3.5-flash-lite', 'gemma-4-26b-a4b-it', 'qwen-plus']);
  });
});

describe('live rewrites through the fallback chain', () => {
  let t;
  let sectionId;
  let calls;
  let respond; // (model, auth) -> Response

  beforeEach(async () => {
    calls = [];
    const config = { ...loadConfig({ GOOGLE_API_KEY: KEY }), maxUploadBytes: 1024 * 1024, adminPin: TEST_PIN, clientDist: null };
    let db;
    const ai = createAiClient({
      getConfig: () => resolveAiConfig(db, config.ai),
      fetchImpl: async (url, init) => {
        const body = init.body ? bodyOf(init) : null;
        calls.push({ url, model: body?.model, auth: init.headers.Authorization, body });
        return respond(body?.model, init.headers.Authorization, url);
      },
      sleep: async () => {},
      random: () => 0,
      log: quiet,
    });
    const { openDb, runMigrations } = await import('../src/db/index.js');
    db = openDb(':memory:');
    runMigrations(db);
    const { createApp } = await import('../src/app.js');
    const app = createApp(db, config, { ai, runner: { enqueue() {} }, clock: () => new Date('2026-10-05T04:00:00.000Z') });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    t = {
      db,
      call: async (method, path, { as = 'P01', body, pin } = {}) => {
        const headers = { 'x-participant': as };
        if (pin) headers['x-admin-pin'] = pin;
        if (body !== undefined) headers['content-type'] = 'application/json';
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
      },
      close: () => new Promise((resolve) => server.close(() => { db.close(); resolve(); })),
    };
    addCodes(db, 'P01', 'P02');
    const lessonId = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('L', 'l.pptx', 't', 1, 'ready')").run().lastInsertRowid);
    db.prepare("INSERT INTO sections (lesson_id, position, title, content, check_questions) VALUES (?, 1, 'First', 'c', '[]')").run(lessonId);
    sectionId = Number(db.prepare("INSERT INTO sections (lesson_id, position, title, content, check_questions) VALUES (?, 2, 'Second', 'A variable is a thing that changes.', '[]')").run(lessonId).lastInsertRowid);
  });
  afterEach(() => t.close());

  const allowStudentKeys = () => t.db.prepare("UPDATE settings SET value = 'true' WHERE key = 'allow_student_keys'").run();
  const saveStudentKey = (participant = 'P01', provider = 'deepseek', model = 'deepseek-chat') => {
    const id = t.db.prepare('SELECT id FROM participants WHERE code = ?').get(participant).id;
    t.db.prepare("INSERT INTO participant_ai_keys VALUES (?, ?, ?, ?, '9876', 'x', 'x')").run(id, provider, model, STUDENT_KEY);
  };
  const aiCalls = () => t.db.prepare('SELECT * FROM ai_calls ORDER BY id').all();
  const simplify = (as) => t.call('POST', `/api/sections/${sectionId}/simplify`, { as });

  it('Default answers first and its answer becomes the shared cached version', async () => {
    respond = () => completion(simpleJson('From default.'));
    const first = await simplify();
    assert.equal(first.status, 200);
    assert.deepEqual([first.body.version.text, first.body.answered_by.source, first.body.shared, first.body.fallback], ['From default.', 'default', true, null]);
    assert.equal(calls[0].model, PRESETS.google.model);
    const again = await simplify('P02');
    assert.equal(again.body.cached, true);
    assert.equal(calls.length, 1);
    const [row] = aiCalls();
    assert.equal(row.section_index, 1, '0-based index of the section in its lesson');
    assert.deepEqual([row.outcome, row.source, row.provider, row.model, row.fallback_steps, row.saved_shared, row.from_cache], ['ok', 'default', 'google', PRESETS.google.model, 0, 1, 0]);
    assert.equal(t.db.prepare('SELECT simple_made_by FROM sections WHERE id = ?').get(sectionId).simple_made_by, `google/${PRESETS.google.model}`);
  });

  it('Default rate-limited: Gemma answers once, with its options, and is not cached', async () => {
    respond = (model) => (model === GEMMA_MODEL ? completion(`<thought>hmm</thought>${simpleJson('From gemma.')}`) : failure(429, { error: { message: 'per minute' } }));
    const res = await simplify();
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.version.text, res.body.answered_by.source, res.body.shared], ['From gemma.', 'gemma', false]);
    assert.equal(res.body.fallback.note, 'The main AI was busy, so a backup AI answered.');
    assert.deepEqual(calls.map((c) => c.model), [PRESETS.google.model, GEMMA_MODEL], 'one try each, no retries');
    const gemma = calls[1];
    assert.equal(gemma.auth, `Bearer ${KEY}`, 'the admin Google key');
    assert.deepEqual([gemma.body.reasoning_effort, gemma.body.max_tokens], ['minimal', 1200]);
    assert.equal(t.db.prepare('SELECT simple_version FROM sections WHERE id = ?').get(sectionId).simple_version, null, 'Gemma answers are not cached');
    // the next request tries Default again
    respond = () => completion(simpleJson('Default is back.'));
    assert.equal((await simplify()).body.answered_by.source, 'default');
    const [first] = aiCalls();
    assert.deepEqual([first.source, first.fallback_steps, first.fallback_reasons, first.saved_shared], ['gemma', 1, 'default:rate_limit', 0]);
  });

  it('a Gemma 429 at the end of the chain says the AI is busy, with no retry loop', async () => {
    respond = () => failure(429, {});
    const res = await simplify();
    assert.equal(res.status, 503);
    assert.equal(res.body.error.message, 'The AI is busy, try again in a minute.');
    assert.equal(calls.length, 2);
    const [row] = aiCalls();
    assert.deepEqual([row.outcome, row.source, row.error_code, row.fallback_steps], ['failed', null, 'rate_limit', 2]);
  });

  it('a bad request does not fall back', async () => {
    respond = () => failure(400, { error: { message: 'Invalid argument' } });
    const res = await simplify();
    assert.equal(res.status, 502);
    // (the client resends once without response_format, as for any 400; Gemma is never asked)
    assert.ok(calls.every((c) => c.model === PRESETS.google.model));
    assert.equal(aiCalls()[0].error_code, 'bad_request');
  });

  it("a student's own key answers first; its answer is theirs only and not cached", async () => {
    allowStudentKeys();
    saveStudentKey();
    respond = (model, auth) => completion(simpleJson(auth === `Bearer ${STUDENT_KEY}` ? 'From my key.' : 'From default.'));
    const mine = await simplify('P01');
    assert.deepEqual([mine.body.version.text, mine.body.answered_by.source, mine.body.shared], ['From my key.', 'student', false]);
    assert.equal(calls[0].url, `${PRESETS.deepseek.baseUrl}/chat/completions`);
    assert.equal(t.db.prepare('SELECT simple_version FROM sections WHERE id = ?').get(sectionId).simple_version, null);
    const theirs = await simplify('P02');
    assert.equal(theirs.body.version.text, 'From default.', 'another student gets the Default');
    // with the switch off, the saved key is not used
    t.db.prepare("UPDATE settings SET value = 'false' WHERE key = 'allow_student_keys'").run();
    assert.equal((await simplify('P01')).body.cached, true);
  });

  it("a student's rejected key (or no credit) falls back to Default, with the note", async () => {
    allowStudentKeys();
    saveStudentKey();
    for (const status of [401, 402]) {
      calls = [];
      t.db.prepare('UPDATE sections SET simple_version = NULL WHERE id = ?').run(sectionId);
      respond = (model, auth) => (auth === `Bearer ${STUDENT_KEY}` ? failure(status, {}) : completion(simpleJson('From default.')));
      const res = await simplify('P01');
      assert.equal(res.status, 200, String(status));
      assert.deepEqual([res.body.answered_by.source, res.body.shared], ['default', true]);
      assert.equal(res.body.fallback.note, 'Your key didn’t work, so the default AI answered.');
    }
    // with a shared version saved, a failed own key falls back to it without asking the AI again
    calls = [];
    respond = (model, auth) => (auth === `Bearer ${STUDENT_KEY}` ? failure(503, {}) : completion(simpleJson('should not be asked')));
    const cachedFallback = await simplify('P01');
    assert.equal(cachedFallback.body.version.text, 'From default.');
    assert.equal(calls.length, 1);
    const last = aiCalls().at(-1);
    assert.deepEqual([last.source, last.from_cache, last.provider, last.model, last.fallback_reasons], ['default', 1, 'google', PRESETS.google.model, 'student:provider_error']);
  });

  it("a student's bad request does not fall back", async () => {
    allowStudentKeys();
    saveStudentKey();
    respond = (model, auth) => (auth === `Bearer ${STUDENT_KEY}` ? failure(400, {}) : completion(simpleJson()));
    assert.equal((await simplify('P01')).status, 502);
    assert.equal(calls.length, 1);
  });

  it('ai_calls is exported with the provider, model, source and fallback steps', async () => {
    respond = (model) => (model === GEMMA_MODEL ? completion(simpleJson()) : failure(500, {}));
    await simplify('P01');
    const csv = exportCsv(t.db, 'ai_calls', { now: new Date(), config: {}, includeP00: false });
    const [header, row] = csv.split('\r\n');
    assert.match(header, /ai_source,ai_provider,ai_model,ai_fallback_steps,ai_fallback_reasons/);
    assert.match(row, /^P01,.*,simplify,ok,gemma,google,gemma-4-26b-a4b-it,1,default:provider_error,/);
  });

  describe('/api/my-ai', () => {
    it('is off until admin allows it; GET says so', async () => {
      const state = await t.call('GET', '/api/my-ai');
      assert.deepEqual([state.status, state.body.allowed, state.body.key, state.body.default.model], [200, false, null, PRESETS.google.model]);
      assert.deepEqual(state.body.providers.map((p) => p.id), ['google', 'deepseek', 'qwen', 'nvidia-nim', 'openrouter']);
      const test = await t.call('POST', '/api/my-ai/key', { body: { provider: 'deepseek', model: 'deepseek-chat', apiKey: STUDENT_KEY } });
      assert.deepEqual([test.status, test.body.error.code], [403, 'student_keys_off']);
    });

    it('saves a key only when the test passes, shows only its last 4 characters, and removes it', async () => {
      allowStudentKeys();
      respond = () => failure(401, { error: { message: 'Authentication Fails' } });
      const bad = await t.call('POST', '/api/my-ai/key', { body: { provider: 'deepseek', model: 'deepseek-chat', apiKey: STUDENT_KEY } });
      assert.deepEqual([bad.status, bad.body.error.message], [400, 'The key was rejected. Check that you copied all of it.']);
      assert.equal(t.db.prepare('SELECT COUNT(*) n FROM participant_ai_keys').get().n, 0);

      respond = () => completion('{"ok":true,"word":"pong"}');
      const good = await t.call('POST', '/api/my-ai/key', { body: { provider: 'deepseek', model: 'deepseek-chat', apiKey: STUDENT_KEY } });
      assert.equal(good.status, 200);
      assert.equal(good.body.message, 'Connected. deepseek-chat is ready.');
      assert.deepEqual(good.body.key, { provider: 'deepseek', provider_label: 'DeepSeek', model: 'deepseek-chat', last4: '9876', updated_at: '2026-10-05T04:00:00.000Z' });
      assert.equal(calls.at(-1).auth, `Bearer ${STUDENT_KEY}`);
      assert.equal(calls.at(-1).model, 'deepseek-chat');
      const state = await t.call('GET', '/api/my-ai');
      assert.ok(!JSON.stringify(state.body).includes(STUDENT_KEY));

      const gone = await t.call('DELETE', '/api/my-ai/key');
      assert.equal(gone.body.key, null);
      assert.equal(t.db.prepare('SELECT COUNT(*) n FROM participant_ai_keys').get().n, 0);
    });

    it('lists the chosen provider\'s chat models with the pasted key', async () => {
      allowStudentKeys();
      respond = () => new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }), { status: 200 });
      const res = await t.call('POST', '/api/my-ai/models', { body: { provider: 'deepseek', apiKey: STUDENT_KEY } });
      assert.deepEqual(res.body.models, ['deepseek-chat', 'deepseek-reasoner']);
      assert.equal(calls[0].url, `${PRESETS.deepseek.baseUrl}/models`);
    });

    it('a deleted participant takes their key and AI log with them; exports never contain keys', async () => {
      allowStudentKeys();
      saveStudentKey();
      respond = () => completion(simpleJson());
      await simplify('P01');
      for (const name of ['summary', 'sessions', 'events', 'ai_calls']) {
        assert.ok(!exportCsv(t.db, name, { now: new Date(), config: {}, includeP00: true }).includes(STUDENT_KEY), name);
      }
      t.db.prepare("DELETE FROM participants WHERE code = 'P01'").run();
      assert.equal(t.db.prepare('SELECT COUNT(*) n FROM participant_ai_keys').get().n, 0);
      assert.equal(t.db.prepare('SELECT COUNT(*) n FROM ai_calls').get().n, 0);
    });
  });

  it('lesson processing uses only the admin Default: never a student key, never Gemma, even when Default fails', async () => {
    allowStudentKeys();
    saveStudentKey();
    respond = () => failure(429, {});
    const lessonId = Number(t.db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('P', 'p.docx', 'A variable changes.', 3, 'processing')").run().lastInsertRowid);
    queueJob(t.db, lessonId);
    const config = loadConfig({ GOOGLE_API_KEY: KEY });
    const ai = createAiClient({
      getConfig: () => resolveAiConfig(t.db, config.ai),
      fetchImpl: async (url, init) => {
        calls.push({ model: bodyOf(init).model, auth: init.headers.Authorization });
        return failure(429, {});
      },
      sleep: async () => {},
      log: quiet,
    });
    await runPipeline({ db: t.db, ai, lessonId, log: quiet });
    assert.equal(t.db.prepare('SELECT status FROM lessons WHERE id = ?').get(lessonId).status, 'failed');
    assert.ok(calls.length > 1);
    for (const c of calls) assert.deepEqual([c.model, c.auth], [PRESETS.google.model, `Bearer ${KEY}`]);
  });
});
