import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AiError, createAiClient, normalizeBaseUrl } from '../src/ai/client.js';
import { parseJsonReply } from '../src/ai/json.js';
import { chatModelIds, isChatModel } from '../src/ai/models.js';

const KEY = 'nvapi-SECRET-KEY-123';
const CFG = { baseUrl: 'https://example.test/v1/', apiKey: KEY, model: 'acme/chat-1' };

const completion = (content, extra = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: extra.finish ?? 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const failure = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// Scripted fetch: each call takes the next entry (a Response, or a function returning/throwing one).
function scriptedFetch(...steps) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return typeof step === 'function' ? step() : step.clone();
  };
  fn.calls = calls;
  return fn;
}

const makeClient = (fetchImpl, cfg = CFG, extra = {}) => {
  const sleeps = [];
  const client = createAiClient({ getConfig: () => cfg, fetchImpl, sleep: async (ms) => void sleeps.push(ms), random: () => 0, ...extra });
  client.sleeps = sleeps;
  return client;
};

const schema = z.object({ answer: z.string().min(1), n: z.number() });

describe('test network guard', () => {
  it('blocks fetches to anything but localhost, so tests can never hit a real provider', () => {
    assert.throws(() => globalThis.fetch('https://integrate.api.nvidia.com/v1/models'), /Tests must not reach the network/);
  });
});

describe('parseJsonReply', () => {
  it('parses plain JSON', () => assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 }));
  it('strips ```json fences', () => assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 }));
  it('strips bare fences and surrounding whitespace', () => assert.deepEqual(parseJsonReply('\n```\n{"a":[1,2]}\n```\n'), { a: [1, 2] }));
  it('drops <think> blocks from reasoning models', () => {
    assert.deepEqual(parseJsonReply('<think>Let me think {about} this</think>\n{"a":1}'), { a: 1 });
  });
  it('finds JSON inside commentary', () => assert.deepEqual(parseJsonReply('Sure! Here you go:\n{"a":{"b":2}}\nHope that helps.'), { a: { b: 2 } }));
  it('accepts a top-level array', () => assert.deepEqual(parseJsonReply('[1,2]'), [1, 2]));
  it('throws on empty and on non-JSON', () => {
    assert.throws(() => parseJsonReply(''), /empty/);
    assert.throws(() => parseJsonReply(null), /empty/);
    assert.throws(() => parseJsonReply('I cannot do that.'), SyntaxError);
    assert.throws(() => parseJsonReply('{"a": '), SyntaxError);
  });
});

describe('chat model filter', () => {
  it('drops embedding, reranking, reward, safety, speech, image and OCR models', () => {
    for (const id of [
      'nvidia/nv-embedqa-e5-v5', 'nvidia/llama-3.2-nv-embedqa-1b-v2', 'snowflake/arctic-embed-l', 'baai/bge-m3',
      'nvidia/nv-rerankqa-mistral-4b-v3', 'nvidia/llama-3.2-nv-rerankqa-1b-v2', 'nvidia/llama-3.1-nemotron-70b-reward',
      'nvidia/llama-3.1-nemoguard-8b-content-safety', 'meta/llama-guard-4-12b', 'nvidia/nvclip', 'openai/whisper-large-v3',
      'nvidia/riva-translate-4b-instruct', 'black-forest-labs/flux.1-dev', 'stabilityai/stable-diffusion-3-medium',
      'nvidia/nemotron-parse', 'nvidia/cosmos-predict2-14b', 'nvidia/parakeet-ctc-1.1b-asr', 'nvidia/nemoretriever-ocr-v1',
      'nvidia/ai-synthetic-video-detector', 'google/deplot',
    ]) {
      assert.equal(isChatModel(id), false, id);
    }
  });

  it('keeps chat models', () => {
    for (const id of [
      'meta/llama-3.1-8b-instruct', 'deepseek-ai/deepseek-v4.1-flash', 'qwen/qwen2.5-coder-32b-instruct', 'mistralai/mistral-7b-instruct-v0.3',
      'nvidia/llama-3.3-nemotron-super-49b-v1', 'google/gemma-2-9b-it', 'llama3.1:8b', 'gpt-4o-mini', 'microsoft/phi-3-mini-4k-instruct',
      'google/diffusiongemma-26b-a4b-it', 'nvidia/cosmos-reason2-8b',
    ]) {
      assert.equal(isChatModel(id), true, id);
    }
  });

  it('uses provider metadata when present', () => {
    assert.equal(isChatModel({ id: 'x/some-model', type: 'embedding' }), false);
    assert.equal(isChatModel({ id: 'x/pic', architecture: { output_modalities: ['image'] } }), false);
    assert.equal(isChatModel({ id: 'x/chatty', architecture: { output_modalities: ['text'] } }), true);
  });

  it('returns unique ids sorted case-insensitively, from an OpenAI-style payload or a bare array', () => {
    const payload = { object: 'list', data: [{ id: 'b/zeta' }, { id: 'A/alpha' }, { id: 'nvidia/nv-embedqa-e5-v5' }, { id: 'b/zeta' }, { id: 'c/Mid' }, {}] };
    assert.deepEqual(chatModelIds(payload), ['A/alpha', 'b/zeta', 'c/Mid']);
    assert.deepEqual(chatModelIds([{ id: 'z' }, { id: 'a' }]), ['a', 'z']);
    assert.deepEqual(chatModelIds({}), []);
  });
});

describe('createAiClient.generateJSON', () => {
  it('sends an OpenAI-style chat request and returns validated JSON', async () => {
    const f = scriptedFetch(completion('{"answer":"hi","n":2}'));
    const out = await makeClient(f).generateJSON({ system: 'SYS', user: 'USER', schema, maxTokens: 321 });
    assert.deepEqual(out, { answer: 'hi', n: 2 });
    const [call] = f.calls;
    assert.equal(call.url, 'https://example.test/v1/chat/completions');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(call.body.model, 'acme/chat-1');
    assert.equal(call.body.max_tokens, 321);
    assert.equal(call.body.stream, false);
    assert.deepEqual(call.body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }]);
  });

  it('strips code fences and think blocks before validating', async () => {
    const f = scriptedFetch(completion('<think>hmm</think>\n```json\n{"answer":"ok","n":1}\n```'));
    assert.deepEqual(await makeClient(f).generateJSON({ system: 's', user: 'u', schema }), { answer: 'ok', n: 1 });
  });

  it('omits Authorization when there is no key (local servers)', async () => {
    const f = scriptedFetch(completion('{"answer":"ok","n":1}'));
    await makeClient(f, { ...CFG, apiKey: '' }).generateJSON({ system: 's', user: 'u', schema });
    assert.equal('Authorization' in f.calls[0].init.headers, false);
  });

  it('retries once when the reply is not JSON, telling the model what was wrong', async () => {
    const f = scriptedFetch(completion('Sorry, I cannot do that.'), completion('{"answer":"fixed","n":3}'));
    const out = await makeClient(f).generateJSON({ system: 's', user: 'ORIGINAL', schema });
    assert.deepEqual(out, { answer: 'fixed', n: 3 });
    assert.equal(f.calls.length, 2);
    const retryUser = f.calls[1].body.messages[1].content;
    assert.ok(retryUser.startsWith('ORIGINAL'));
    assert.match(retryUser, /previous reply was rejected: it was not valid JSON/);
  });

  it('retries once when the JSON does not match the schema, naming the problem field', async () => {
    const f = scriptedFetch(completion('{"answer":"","n":"two"}'), completion('{"answer":"ok","n":2}'));
    await makeClient(f).generateJSON({ system: 's', user: 'u', schema });
    assert.equal(f.calls.length, 2);
    assert.match(f.calls[1].body.messages[1].content, /did not match the required format \(answer: .*; n: /);
  });

  it('mentions truncation in the retry note when the reply was cut off', async () => {
    const f = scriptedFetch(completion('{"answer": "long', { finish: 'length' }), completion('{"answer":"ok","n":1}'));
    await makeClient(f).generateJSON({ system: 's', user: 'u', schema });
    assert.match(f.calls[1].body.messages[1].content, /cut off for being too long/);
  });

  it('retries a reply cut off by the token limit (e.g. a reasoning model that never wrote JSON) with double the budget', async () => {
    const f = scriptedFetch(completion('', { finish: 'length' }), completion('{"answer":"ok","n":1}'));
    await makeClient(f).generateJSON({ system: 's', user: 'u', schema, maxTokens: 4000 });
    assert.deepEqual(f.calls.map((c) => c.body.max_tokens), [4000, 8000]);
  });

  it('keeps the same budget when the reply was invalid but not cut off, and caps the doubled budget', async () => {
    const f = scriptedFetch(completion('nope'), completion('{"answer":"ok","n":1}'));
    await makeClient(f).generateJSON({ system: 's', user: 'u', schema, maxTokens: 4000 });
    assert.deepEqual(f.calls.map((c) => c.body.max_tokens), [4000, 4000]);
    const g = scriptedFetch(completion('', { finish: 'length' }), completion('{"answer":"ok","n":1}'));
    await makeClient(g).generateJSON({ system: 's', user: 'u', schema, maxTokens: 12000 });
    assert.deepEqual(g.calls.map((c) => c.body.max_tokens), [12000, 16000]);
  });

  it('gives a clear error after the second invalid reply (exactly two calls)', async () => {
    const f = scriptedFetch(completion('nope'), completion('still nope'));
    await assert.rejects(
      makeClient(f).generateJSON({ system: 's', user: 'u', schema, label: 'the key terms (part 2 of 3)' }),
      (err) => {
        assert.ok(err instanceof AiError);
        assert.equal(err.code, 'invalid_json');
        assert.equal(err.status, 502);
        assert.match(err.message, /for the key terms \(part 2 of 3\) after 2 tries/);
        return true;
      },
    );
    assert.equal(f.calls.length, 2);
  });

  it('treats an empty reply (e.g. a reasoning model out of tokens) as invalid and retries', async () => {
    const f = scriptedFetch(completion(''), completion('{"answer":"ok","n":1}'));
    assert.deepEqual(await makeClient(f).generateJSON({ system: 's', user: 'u', schema }), { answer: 'ok', n: 1 });
    assert.match(f.calls[1].body.messages[1].content, /reply was empty/);
  });

  it('counts calls and tokens', async () => {
    const f = scriptedFetch(completion('{"answer":"ok","n":1}'));
    const client = makeClient(f);
    await client.generateJSON({ system: 's', user: 'u', schema });
    assert.deepEqual(client.stats, { calls: 1, promptTokens: 10, completionTokens: 5, jsonRetries: 0, httpRetries: 0, truncated: 0 });
  });
});

describe('createAiClient errors', () => {
  const run = (f, cfg) => makeClient(f, cfg).generateJSON({ system: 's', user: 'u', schema });

  it('is not_configured (400) without calling the network when URL or model is missing', async () => {
    for (const cfg of [{ baseUrl: '', apiKey: 'k', model: 'm' }, { baseUrl: 'https://x.test/v1', apiKey: 'k', model: '' }]) {
      const f = scriptedFetch(completion('{}'));
      await assert.rejects(run(f, cfg), (err) => err.code === 'not_configured' && err.status === 400 && /isn't set up/.test(err.message));
      assert.equal(f.calls.length, 0);
    }
  });

  it('rejects a base URL that is not a URL', async () => {
    await assert.rejects(run(scriptedFetch(completion('{}')), { baseUrl: 'not a url', apiKey: '', model: 'm' }), (err) => err.code === 'not_configured' && /isn't a valid URL/.test(err.message));
  });

  it('maps 401 to an API-key message without retrying and never leaks the key', async () => {
    const f = scriptedFetch(failure(401, { detail: `Authorization failed for key ${KEY}` }));
    const client = makeClient(f);
    await assert.rejects(client.generateJSON({ system: 's', user: 'u', schema }), (err) => {
      assert.equal(err.code, 'auth');
      assert.match(err.message, /rejected the API key \(HTTP 401\)/);
      assert.ok(!err.message.includes(KEY), 'key must be redacted');
      assert.match(err.message, /Authorization failed for key \*\*\*/);
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(client.sleeps, []);
  });

  it('maps 404 to a base URL / model hint', async () => {
    await assert.rejects(run(scriptedFetch(failure(404, { error: { message: 'model not found' } }))), (err) => err.code === 'not_found' && /base URL and model name/.test(err.message) && /model not found/.test(err.message));
  });

  it('adds a context-window hint to a 400 about token limits', async () => {
    const f = scriptedFetch(failure(400, { error: { message: "This model's maximum context length is 4096 tokens" } }));
    await assert.rejects(run(f), (err) => err.code === 'bad_request' && /context window may be too small/.test(err.message));
    assert.equal(f.calls.length, 1);
  });

  it('retries a 429 honoring Retry-After, then succeeds', async () => {
    const f = scriptedFetch(failure(429, { error: 'slow down' }, { 'retry-after': '3' }), completion('{"answer":"ok","n":1}'));
    const client = makeClient(f);
    assert.deepEqual(await client.generateJSON({ system: 's', user: 'u', schema }), { answer: 'ok', n: 1 });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(client.sleeps, [3000]);
  });

  it('gives up on a persistent 429 after 5 attempts with a rate-limit message', async () => {
    const f = scriptedFetch(failure(429, { error: 'slow down' }));
    const client = makeClient(f);
    await assert.rejects(client.generateJSON({ system: 's', user: 'u', schema }), (err) => err.code === 'rate_limit' && /rate-limiting/.test(err.message));
    assert.equal(f.calls.length, 5);
    assert.deepEqual(client.sleeps, [2000, 6000, 15000, 30000]);
  });

  it('retries a 503 and then reports a provider error', async () => {
    const f = scriptedFetch(failure(503, 'upstream down'));
    await assert.rejects(run(f), (err) => err.code === 'provider_error' && /HTTP 503/.test(err.message));
    assert.equal(f.calls.length, 5);
  });

  it('does not retry a refused connection and names the host', async () => {
    const refused = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    const f = scriptedFetch(refused);
    await assert.rejects(run(f), (err) => err.code === 'network' && /connect to the AI provider at example\.test/.test(err.message));
    assert.equal(f.calls.length, 1);
  });

  it('retries a dropped connection once it is not a refusal', async () => {
    const reset = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
    const f = scriptedFetch(reset, () => completion('{"answer":"ok","n":1}'));
    assert.deepEqual(await run(f), { answer: 'ok', n: 1 });
    assert.equal(f.calls.length, 2);
  });

  it('reports a timeout (504) without retrying', async () => {
    const f = scriptedFetch(() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); });
    await assert.rejects(run(f), (err) => err.code === 'timeout' && err.status === 504 && /didn't answer within/.test(err.message));
    assert.equal(f.calls.length, 1);
  });

  it('explains a non-JSON HTTP 200 (wrong base URL)', async () => {
    const f = scriptedFetch(new Response('<html>Welcome</html>', { status: 200 }));
    await assert.rejects(run(f), (err) => err.code === 'bad_response' && /OpenAI-compatible/.test(err.message));
  });

  it('explains a reply with no choices', async () => {
    const f = scriptedFetch(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await assert.rejects(run(f), (err) => err.code === 'bad_response' && /chat model/.test(err.message));
  });

  it('normalizes base URLs', () => {
    assert.equal(normalizeBaseUrl(' https://a.test/v1/ '), 'https://a.test/v1');
    assert.equal(normalizeBaseUrl('https://a.test/v1/chat/completions'), 'https://a.test/v1');
    assert.equal(normalizeBaseUrl('http://localhost:11434/v1/models'), 'http://localhost:11434/v1');
  });
});

describe('createAiClient.listModels / testConnection', () => {
  const modelsBody = { data: [{ id: 'nvidia/nv-embedqa-e5-v5' }, { id: 'meta/llama-3.1-8b-instruct' }, { id: 'deepseek-ai/deepseek-v4.1-flash' }] };

  it('GETs {baseUrl}/models and returns sorted chat models', async () => {
    const f = scriptedFetch(new Response(JSON.stringify(modelsBody), { status: 200 }));
    assert.deepEqual(await makeClient(f).listModels(), ['deepseek-ai/deepseek-v4.1-flash', 'meta/llama-3.1-8b-instruct']);
    assert.equal(f.calls[0].url, 'https://example.test/v1/models');
    assert.equal(f.calls[0].init.method, 'GET');
  });

  it('needs a base URL but not a model', async () => {
    const f = scriptedFetch(new Response(JSON.stringify(modelsBody), { status: 200 }));
    assert.equal((await makeClient(f, { baseUrl: 'https://x.test/v1', apiKey: '', model: '' }).listModels()).length, 2);
  });

  it('testConnection asks for a tiny JSON object and validates it', async () => {
    const f = scriptedFetch(completion('```json\n{"ok": true, "word": "pong"}\n```'));
    const out = await makeClient(f).testConnection();
    assert.deepEqual({ ok: out.ok, model: out.model, reply: out.reply }, { ok: true, model: 'acme/chat-1', reply: { ok: true, word: 'pong' } });
    assert.equal(typeof out.latencyMs, 'number');
    assert.match(f.calls[0].body.messages[1].content, /"ok": true/);
  });

  it('testConnection fails clearly when the model ignores the format', async () => {
    const f = scriptedFetch(completion('{"ok": false}'));
    await assert.rejects(makeClient(f).testConnection(), (err) => err.code === 'invalid_json' && /the connection test/.test(err.message));
  });
});
