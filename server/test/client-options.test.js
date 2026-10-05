import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chatModelIds, isChatModel } from '../src/ai/models.js';
import { CFG, completion, failure, makeClient, schema, scriptedFetch } from './helpers.js';

describe('createAiClient: jitter, extra body, response_format, provider config', () => {
  it('adds up to 25% jitter to backoff waits so parallel retries do not move in lockstep', async () => {
    const f = scriptedFetch(failure(503, 'overloaded'), failure(503, 'overloaded'), completion('{"answer":"ok","n":1}'));
    const client = makeClient(f, CFG, { random: () => 1 });
    await client.generateJSON({ system: 's', user: 'u', schema });
    assert.deepEqual(client.sleeps, [2500, 7500]);
    assert.equal(client.stats.httpRetries, 2);
  });

  it('jitters a Retry-After wait too', async () => {
    const f = scriptedFetch(failure(429, 'slow', { 'retry-after': '4' }), completion('{"answer":"ok","n":1}'));
    const client = makeClient(f, CFG, { random: () => 0.5 });
    await client.generateJSON({ system: 's', user: 'u', schema });
    assert.deepEqual(client.sleeps, [4500]);
  });

  it('counts JSON retries and truncated replies', async () => {
    const f = scriptedFetch(completion('nope'), completion('{"answer":"ok","n":1}'));
    const client = makeClient(f);
    await client.generateJSON({ system: 's', user: 'u', schema });
    assert.equal(client.stats.jsonRetries, 1);
    const g = scriptedFetch(completion('', { finish: 'length' }), completion('{"answer":"ok","n":1}'));
    const c2 = makeClient(g);
    await c2.generateJSON({ system: 's', user: 'u', schema, maxTokens: 100 });
    assert.deepEqual({ json: c2.stats.jsonRetries, cut: c2.stats.truncated }, { json: 1, cut: 1 });
  });

  it('merges AI_EXTRA_BODY into the request but cannot replace the model or the messages', async () => {
    const f = scriptedFetch(completion('{"answer":"ok","n":1}'));
    const extraBody = { chat_template_kwargs: { thinking: false }, temperature: 0.9, model: 'evil/model', messages: [] };
    await makeClient(f, { ...CFG, extraBody }).generateJSON({ system: 'SYS', user: 'USER', schema });
    const { body } = f.calls[0];
    assert.deepEqual(body.chat_template_kwargs, { thinking: false });
    assert.equal(body.temperature, 0.9, 'provider options may tune sampling');
    assert.equal(body.model, 'acme/chat-1');
    assert.equal(body.messages.length, 2);
  });

  const responseSchema = { name: 'reply', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } };

  it('sends response_format json_schema only to providers that support it, and still validates with zod', async () => {
    const f = scriptedFetch(completion('{"answer":"ok","n":1}'));
    await makeClient(f, { ...CFG, jsonSchema: true }).generateJSON({ system: 's', user: 'u', schema, responseSchema });
    assert.deepEqual(f.calls[0].body.response_format, { type: 'json_schema', json_schema: { name: 'reply', schema: responseSchema.schema } });

    const g = scriptedFetch(completion('{"answer":"ok","n":1}'));
    await makeClient(g, { ...CFG, jsonSchema: false }).generateJSON({ system: 's', user: 'u', schema, responseSchema });
    assert.equal('response_format' in g.calls[0].body, false);

    const h = scriptedFetch(completion('{"answer":"ok","n":"not a number"}'), completion('{"answer":"ok","n":2}'));
    assert.deepEqual(await makeClient(h, { ...CFG, jsonSchema: true }).generateJSON({ system: 's', user: 'u', schema, responseSchema }), { answer: 'ok', n: 2 });
    assert.equal(h.calls.length, 2, 'the one JSON retry still applies');
  });

  it('falls back to a plain request when the endpoint rejects response_format, and remembers it', async () => {
    const f = scriptedFetch(failure(400, { error: { message: 'Unknown field response_format' } }), completion('{"answer":"ok","n":1}'), completion('{"answer":"ok","n":2}'));
    const client = makeClient(f, { ...CFG, jsonSchema: true });
    assert.deepEqual(await client.generateJSON({ system: 's', user: 'u', schema, responseSchema }), { answer: 'ok', n: 1 });
    assert.deepEqual(f.calls.map((c) => 'response_format' in c.body), [true, false]);
    await client.generateJSON({ system: 's', user: 'u', schema, responseSchema });
    assert.equal('response_format' in f.calls[2].body, false, 'not sent again to that host');
  });

  it('does not blame response_format for a request that fails either way', async () => {
    const f = scriptedFetch(failure(400, 'too long'), failure(400, 'too long'), completion('{"answer":"ok","n":1}'));
    const client = makeClient(f, { ...CFG, jsonSchema: true });
    await assert.rejects(client.generateJSON({ system: 's', user: 'u', schema, responseSchema }), (err) => err.code === 'bad_request');
    await client.generateJSON({ system: 's', user: 'u', schema, responseSchema });
    assert.equal('response_format' in f.calls[2].body, true, 'still tried');
  });

  it('is not_configured, naming the provider and its .env variable, when a keyed provider has no key', async () => {
    const f = scriptedFetch(completion('{}'));
    const cfg = { baseUrl: 'https://x.test/v1', apiKey: '', model: 'm', needsKey: true, label: 'Google Gemini', keyEnv: 'GOOGLE_API_KEY' };
    await assert.rejects(makeClient(f, cfg).generateJSON({ system: 's', user: 'u', schema }), (err) => err.code === 'not_configured' && /Google Gemini[^]*GOOGLE_API_KEY/.test(err.message));
    assert.equal(f.calls.length, 0);
  });

  it('a one-off config replaces the client config for that call (test before saving)', async () => {
    const f = scriptedFetch(completion('{"ok": true, "word": "pong"}'));
    const out = await makeClient(f).testConnection({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1:8b' });
    assert.equal(out.model, 'llama3.1:8b');
    assert.equal(f.calls[0].url, 'http://localhost:11434/v1/chat/completions');
  });

  it('listModels strips the "models/" prefix and returns [] instead of failing when the provider lists nothing', async () => {
    const f = scriptedFetch(new Response(JSON.stringify({ data: [{ id: 'models/gemini-x-flash' }, { id: 'models/text-embedding-004' }, { id: 'models/gemini-a-pro' }] })));
    assert.deepEqual(await makeClient(f).listModels(), ['gemini-a-pro', 'gemini-x-flash']);
    const g = scriptedFetch(new Response(JSON.stringify({ data: [] })));
    assert.deepEqual(await makeClient(g).listModels(), []);
  });
});

describe('chat model filter: Gemini', () => {
  it('drops embedding, Imagen, Veo, TTS, live, audio and image models', () => {
    for (const id of [
      'models/text-embedding-004', 'gemini-embedding-001', 'imagen-4.0-generate-001', 'veo-3.0-generate-preview',
      'gemini-2.5-flash-preview-tts', 'gemini-live-2.5-flash', 'gemini-2.5-flash-native-audio-preview', 'gemini-2.5-flash-image',
      'gemini-robotics-er-1.5-preview', 'gemini-3.5-transcribe', 'lyria-3.5',
    ]) {
      assert.equal(isChatModel(id), false, id);
    }
  });

  it('keeps Gemini chat models, with or without the models/ prefix', () => {
    for (const id of ['gemini-3.5-flash-lite', 'models/gemini-3.5-flash', 'gemini-2.5-pro', 'gemma-3-27b-it']) assert.equal(isChatModel(id), true, id);
    assert.deepEqual(chatModelIds({ data: [{ id: 'models/gemini-3.5-flash-lite' }, { id: 'models/veo-3.0-generate' }] }), ['gemini-3.5-flash-lite']);
  });

  it('uses supportedGenerationMethods when Google lists them', () => {
    assert.equal(isChatModel({ id: 'models/gemini-x', supportedGenerationMethods: ['generateContent', 'countTokens'] }), true);
    assert.equal(isChatModel({ id: 'models/gemini-y', supportedGenerationMethods: ['embedContent'] }), false);
  });
});
