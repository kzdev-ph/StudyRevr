import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAiClient } from '../src/ai/client.js';
import { PRESETS } from '../src/ai/providers.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { resolveAiConfig } from '../src/services/settings.js';
import { completion, failure, KEY, scriptedFetch } from './helpers.js';

const modelsBody = (...ids) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });

describe('AI settings routes', () => {
  let db;
  let server;
  let base;
  let fetchImpl;
  let config;

  const start = async (envVars) => {
    config = { ...loadConfig(envVars), maxUploadBytes: 1024 * 1024 };
    const client = createAiClient({
      getConfig: () => resolveAiConfig(db, config.ai),
      fetchImpl: (...a) => fetchImpl(...a),
      sleep: async () => {},
      random: () => 0,
    });
    const app = createApp(db, config, { ai: client, runner: { enqueue() {} } });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () => new Promise((resolve) => server.close(resolve));
  const api = async (path, init) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: await res.json() };
  };
  const send = (method, path, body) => api(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeEach(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    await start({ GOOGLE_API_KEY: KEY });
  });
  afterEach(async () => {
    await stop();
    db.close();
  });

  it('GET /models lists the active provider\'s chat models, sorted, without the models/ prefix', async () => {
    fetchImpl = scriptedFetch(modelsBody('models/gemini-b', 'models/text-embedding-004', 'models/gemini-a', 'models/imagen-4.0-generate-001'));
    const { status, body } = await api('/api/settings/models');
    assert.equal(status, 200);
    assert.deepEqual(body.models, ['gemini-a', 'gemini-b']);
    assert.deepEqual([body.provider, body.freeText, body.defaultModel], ['google', false, PRESETS.google.model]);
    assert.equal(fetchImpl.calls[0].url, `${PRESETS.google.baseUrl}/models`);
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  });

  it('GET /models?provider= browses another provider, using that provider\'s own key', async () => {
    await send('PUT', '/api/settings/ai', { provider: 'openrouter', apiKey: 'sk-or-1' });
    await send('PUT', '/api/settings/ai', { provider: 'google' });
    fetchImpl = scriptedFetch(modelsBody('b/two', 'a/one'));
    const { body } = await api('/api/settings/models?provider=openrouter');
    assert.deepEqual(body.models, ['a/one', 'b/two']);
    assert.equal(body.provider, 'openrouter');
    assert.equal(fetchImpl.calls[0].url, 'https://openrouter.ai/api/v1/models');
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer sk-or-1', 'not the Google key');
  });

  it('GET /models still answers 200 with freeText when the provider fails or lists nothing', async () => {
    fetchImpl = scriptedFetch(failure(401, { error: { message: 'API key not valid' } }));
    let res = await api('/api/settings/models');
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.models, res.body.freeText, res.body.error.code], [[], true, 'auth']);
    assert.ok(!JSON.stringify(res.body).includes(KEY));

    fetchImpl = scriptedFetch(modelsBody());
    res = await api('/api/settings/models');
    assert.deepEqual([res.status, res.body.models, res.body.freeText, res.body.error], [200, [], true, undefined]);

    await stop();
    db.close();
    db = openDb(':memory:');
    runMigrations(db);
    await start({}); // no key at all
    res = await api('/api/settings/models');
    assert.deepEqual([res.status, res.body.freeText, res.body.error.code], [200, true, 'not_configured']);
    assert.match(res.body.error.hint, /GOOGLE_API_KEY/);
    assert.doesNotMatch(res.body.error.message, /GOOGLE_API_KEY/);
  });

  it('PUT /ai saves provider, per-provider model and key; GET /ai never returns a key', async () => {
    let res = await send('PUT', '/api/settings/ai', { provider: 'nvidia-nim', model: 'nvidia/nemotron-x', apiKey: 'nvapi-SECRET' });
    assert.equal(res.status, 200);
    assert.equal(res.body.provider, 'nvidia-nim');
    res = await api('/api/settings/ai');
    assert.ok(!JSON.stringify(res.body).includes('SECRET'));
    assert.ok(!JSON.stringify(res.body).includes(KEY));
    const byId = Object.fromEntries(res.body.providers.map((p) => [p.id, p]));
    assert.deepEqual([byId['nvidia-nim'].model, byId['nvidia-nim'].keySet, byId.google.keySet, byId.openrouter.keySet], ['nvidia/nemotron-x', true, true, false]);

    await send('PUT', '/api/settings/ai', { provider: 'google', model: 'models/gemini-custom' });
    await send('PUT', '/api/settings/ai', { provider: 'nvidia-nim' });
    res = await api('/api/settings/ai');
    assert.equal(res.body.providers.find((p) => p.id === 'nvidia-nim').model, 'nvidia/nemotron-x');
    assert.equal(res.body.providers.find((p) => p.id === 'google').model, 'gemini-custom');
  });

  it('PUT /ai accepts any model id (free text) and rejects bad input with a 400', async () => {
    assert.equal((await send('PUT', '/api/settings/ai', { model: 'my/private-model:7b' })).status, 200);
    for (const bad of [{ provider: 'skynet' }, { baseUrl: 'ftp://x' }, { apiKey: 7 }, { colour: 'red' }]) {
      const res = await send('PUT', '/api/settings/ai', bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.match(res.body.error.message, /^Invalid /);
    }
  });

  it('POST /test-ai tests the provider and model in the body, without saving them', async () => {
    fetchImpl = scriptedFetch(completion('{"ok": true, "word": "pong"}'));
    const res = await send('POST', '/api/settings/test-ai', { provider: 'ollama', model: 'llama3.1:8b' });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.ok, res.body.provider, res.body.model, res.body.reply], [true, 'ollama', 'llama3.1:8b', { ok: true, word: 'pong' }]);
    assert.equal(fetchImpl.calls[0].url, 'http://localhost:11434/v1/chat/completions');
    assert.equal('Authorization' in fetchImpl.calls[0].init.headers, false, 'the Google key is not sent to Ollama');
    assert.equal((await api('/api/settings/ai')).body.provider, 'google', 'nothing was saved');
  });

  it('POST /test-ai can try a new key before it is saved, and never echoes it', async () => {
    fetchImpl = scriptedFetch(failure(403, { error: { message: `API key ${'AIza-NEW-KEY'} not valid` } }));
    const res = await send('POST', '/api/settings/test-ai', { provider: 'google', apiKey: 'AIza-NEW-KEY' });
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'auth');
    assert.ok(!JSON.stringify(res.body).includes('AIza-NEW-KEY'));
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer AIza-NEW-KEY');
  });

  it('POST /test-ai with no body tests the saved/active provider; a wrong-shaped answer is a 502', async () => {
    fetchImpl = scriptedFetch(completion('Pong!'));
    const res = await send('POST', '/api/settings/test-ai');
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'invalid_json');
  });

  it('POST /test-ai is a 400 not_configured when the provider needs a key and has none', async () => {
    await stop();
    db.close();
    db = openDb(':memory:');
    runMigrations(db);
    await start({});
    fetchImpl = scriptedFetch(completion('{}'));
    const res = await send('POST', '/api/settings/test-ai', { provider: 'openrouter' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'not_configured');
    assert.match(res.body.error.hint, /OPENROUTER_API_KEY/);
    assert.doesNotMatch(res.body.error.message, /OPENROUTER_API_KEY|HTTP/);
    assert.equal(fetchImpl.calls.length, 0);
  });
});
