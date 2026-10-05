import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../src/ai/pool.js';
import { inferProvider, PRESETS, PROVIDER_IDS } from '../src/ai/providers.js';
import { loadConfig, parseExtraBody } from '../src/config.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { describeAiSettings, resolveAiConfig, saveAiSettings } from '../src/services/settings.js';

const env = (vars = {}) => loadConfig({ ...vars }).ai;

describe('provider presets', () => {
  it('has google (the default), nvidia-nim, openrouter, ollama and llamacpp, each with base URL, model, chunk size and concurrency', () => {
    for (const id of ['google', 'nvidia-nim', 'openrouter', 'ollama', 'llamacpp']) {
      const p = PRESETS[id];
      assert.ok(PROVIDER_IDS.includes(id));
      assert.match(p.baseUrl, /^https?:\/\//, id);
      assert.ok(p.model, id);
      assert.ok(p.chunkTokens > 0 && p.concurrency > 0, id);
    }
  });

  it('google: the OpenAI-compatible Gemini endpoint, ~30000-token chunks and 2 parallel calls for the 15 requests/minute free tier', () => {
    assert.equal(PRESETS.google.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
    assert.equal(PRESETS.google.chunkTokens, 30_000);
    assert.equal(PRESETS.google.concurrency, 2);
    assert.equal(PRESETS.google.jsonSchema, true);
    assert.equal(PRESETS['nvidia-nim'].chunkTokens, 2400, 'the other presets keep the small-model chunking');
  });

  it('infers the provider of an older .env that only sets AI_BASE_URL', () => {
    assert.equal(inferProvider('https://integrate.api.nvidia.com/v1'), 'nvidia-nim');
    assert.equal(inferProvider('http://localhost:11434/v1'), 'ollama');
    assert.equal(inferProvider('https://my-server.example/v1'), 'custom');
    assert.equal(inferProvider(''), null);
  });
});

describe('resolveAiConfig', () => {
  let db;
  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
  });

  it('defaults to google with the preset values and no key', () => {
    const c = resolveAiConfig(db, env());
    assert.equal(c.provider, 'google');
    assert.equal(c.baseUrl, PRESETS.google.baseUrl);
    assert.equal(c.model, PRESETS.google.model);
    assert.equal(c.apiKey, '');
    assert.equal(c.chunkTokens, 30_000);
    assert.equal(c.concurrency, 2);
    assert.equal(c.keyTermsMax, 12);
  });

  it('uses the .env key of the active provider only', () => {
    const e = env({ GOOGLE_API_KEY: 'g-key', NVIDIA_API_KEY: 'n-key', OPENROUTER_API_KEY: 'o-key' });
    assert.equal(resolveAiConfig(db, e).apiKey, 'g-key');
    assert.equal(resolveAiConfig(db, e, { provider: 'nvidia-nim' }).apiKey, 'n-key');
    assert.equal(resolveAiConfig(db, e, { provider: 'openrouter' }).apiKey, 'o-key');
    assert.equal(resolveAiConfig(db, e, { provider: 'ollama' }).apiKey, '');
  });

  it('AI_PROVIDER picks the provider; an unknown name falls back to google', () => {
    assert.equal(resolveAiConfig(db, env({ AI_PROVIDER: 'NVIDIA-NIM' })).provider, 'nvidia-nim');
    assert.equal(resolveAiConfig(db, env({ AI_PROVIDER: 'nope' })).provider, 'google');
  });

  it('order is: request override > settings table > .env > preset', () => {
    const e = env({ AI_PROVIDER: 'nvidia-nim', AI_MODEL: 'env/model', NVIDIA_API_KEY: 'env-key' });
    assert.equal(resolveAiConfig(db, e).model, 'env/model', '.env beats the preset');
    assert.equal(resolveAiConfig(db, env({ AI_PROVIDER: 'nvidia-nim' })).model, PRESETS['nvidia-nim'].model);

    saveAiSettings(db, { model: 'saved/model', apiKey: 'saved-key' }, e);
    const saved = resolveAiConfig(db, e);
    assert.deepEqual([saved.model, saved.apiKey], ['saved/model', 'saved-key'], 'the Settings value beats .env');

    const one = resolveAiConfig(db, e, { model: 'tryout/model', apiKey: 'tryout-key' });
    assert.deepEqual([one.model, one.apiKey], ['tryout/model', 'tryout-key'], 'a request override beats the saved value');
  });

  it('AI_BASE_URL / AI_API_KEY / AI_MODEL are optional overrides for the .env provider only', () => {
    const e = env({ AI_PROVIDER: 'google', AI_BASE_URL: 'https://proxy.example/v1beta/openai', AI_API_KEY: 'override-key', AI_MODEL: 'gemini-x', GOOGLE_API_KEY: 'g-key' });
    const g = resolveAiConfig(db, e);
    assert.deepEqual([g.baseUrl, g.apiKey, g.model], ['https://proxy.example/v1beta/openai', 'override-key', 'gemini-x']);
    const n = resolveAiConfig(db, e, { provider: 'nvidia-nim' });
    assert.equal(n.baseUrl, PRESETS['nvidia-nim'].baseUrl, 'not leaked to another provider');
    assert.equal(n.apiKey, '');
    assert.equal(n.model, PRESETS['nvidia-nim'].model);
  });

  it('an older .env (AI_BASE_URL + AI_API_KEY + AI_MODEL, no AI_PROVIDER) keeps working as that provider', () => {
    const c = resolveAiConfig(db, env({ AI_BASE_URL: 'https://integrate.api.nvidia.com/v1', AI_API_KEY: 'k', AI_MODEL: 'deepseek-ai/x' }));
    assert.deepEqual([c.provider, c.apiKey, c.model], ['nvidia-nim', 'k', 'deepseek-ai/x']);
    assert.equal(c.chunkTokens, 2400);
  });

  it('AI_CHUNK_TOKENS and AI_CONCURRENCY override the preset; settings override those; bad values are ignored', () => {
    assert.deepEqual(
      [resolveAiConfig(db, env({ AI_CHUNK_TOKENS: '8000', AI_CONCURRENCY: '5' })).chunkTokens, resolveAiConfig(db, env({ AI_CHUNK_TOKENS: '8000', AI_CONCURRENCY: '5' })).concurrency],
      [8000, 5],
    );
    const bad = resolveAiConfig(db, env({ AI_CHUNK_TOKENS: 'lots', AI_CONCURRENCY: '0' }));
    assert.deepEqual([bad.chunkTokens, bad.concurrency], [30_000, 2]);
    db.prepare("INSERT INTO settings (key, value) VALUES ('ai_concurrency', '3')").run();
    assert.equal(resolveAiConfig(db, env({ AI_CONCURRENCY: '5' })).concurrency, 3);
  });

  it('KEY_TERMS_MAX: setting > .env > 12, capped at 50', () => {
    assert.equal(resolveAiConfig(db, env({ KEY_TERMS_MAX: '8' })).keyTermsMax, 8);
    db.prepare("INSERT INTO settings (key, value) VALUES ('key_terms_max', '15')").run();
    assert.equal(resolveAiConfig(db, env({ KEY_TERMS_MAX: '8' })).keyTermsMax, 15);
    db.prepare("UPDATE settings SET value = '500' WHERE key = 'key_terms_max'").run();
    assert.equal(resolveAiConfig(db, env()).keyTermsMax, 50);
  });

  it('strips a "models/" prefix from the model id', () => {
    assert.equal(resolveAiConfig(db, env(), { model: 'models/gemini-3.5-flash' }).model, 'gemini-3.5-flash');
  });

  it('AI_EXTRA_BODY applies only to the .env provider', () => {
    const e = env({ AI_PROVIDER: 'nvidia-nim', AI_EXTRA_BODY: '{"chat_template_kwargs":{"thinking":false}}' });
    assert.deepEqual(resolveAiConfig(db, e).extraBody, { chat_template_kwargs: { thinking: false } });
    assert.equal(resolveAiConfig(db, e, { provider: 'google' }).extraBody, undefined);
  });

  it('remembers the chosen model per provider, so switching providers restores each one\'s last model', () => {
    saveAiSettings(db, { provider: 'google', model: 'gemini-a' });
    saveAiSettings(db, { provider: 'nvidia-nim', model: 'nvidia/b' });
    assert.deepEqual([resolveAiConfig(db, env()).provider, resolveAiConfig(db, env()).model], ['nvidia-nim', 'nvidia/b']);
    saveAiSettings(db, { provider: 'google' });
    assert.deepEqual([resolveAiConfig(db, env()).provider, resolveAiConfig(db, env()).model], ['google', 'gemini-a']);
    saveAiSettings(db, { model: 'gemini-c' }); // no provider: applies to the active one
    assert.equal(resolveAiConfig(db, env(), { provider: 'nvidia-nim' }).model, 'nvidia/b');
    assert.equal(resolveAiConfig(db, env()).model, 'gemini-c');
  });

  it('keys are stored per provider and an empty string clears a saved value', () => {
    saveAiSettings(db, { provider: 'google', apiKey: 'g-saved' });
    saveAiSettings(db, { provider: 'openrouter', apiKey: 'o-saved' });
    assert.equal(resolveAiConfig(db, env(), { provider: 'google' }).apiKey, 'g-saved');
    assert.equal(resolveAiConfig(db, env(), { provider: 'openrouter' }).apiKey, 'o-saved');
    saveAiSettings(db, { provider: 'google', apiKey: '' });
    assert.equal(resolveAiConfig(db, env(), { provider: 'google' }).apiKey, '');
  });

  it('describeAiSettings never contains an API key, only whether one is set', () => {
    saveAiSettings(db, { provider: 'openrouter', apiKey: 'sk-or-SECRET', model: 'meta/some-model' });
    const view = describeAiSettings(db, env({ GOOGLE_API_KEY: 'AIza-SECRET' }));
    const text = JSON.stringify(view);
    assert.ok(!text.includes('SECRET'));
    assert.equal(view.provider, 'openrouter');
    const byId = Object.fromEntries(view.providers.map((p) => [p.id, p]));
    assert.deepEqual([byId.google.keySet, byId.openrouter.keySet, byId['nvidia-nim'].keySet, byId.ollama.keySet], [true, true, false, false]);
    assert.equal(byId.openrouter.model, 'meta/some-model');
    assert.equal(byId.google.defaultModel, PRESETS.google.model);
  });
});

describe('AI_EXTRA_BODY', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);

  it('parses a JSON object', () => {
    assert.deepEqual(parseExtraBody('{"reasoning_effort":"none","n":{"a":1}}', warn), { reasoning_effort: 'none', n: { a: 1 } });
    assert.equal(warnings.length, 0);
  });

  it('is ignored when empty, unparseable or not an object, and never echoes the value', () => {
    assert.equal(parseExtraBody('', warn), undefined);
    assert.equal(parseExtraBody(undefined, warn), undefined);
    assert.equal(parseExtraBody('{oops', warn), undefined);
    assert.equal(parseExtraBody('["a"]', warn), undefined);
    assert.equal(parseExtraBody('"just text"', warn), undefined);
    assert.equal(parseExtraBody('null', warn), undefined);
    assert.equal(warnings.length, 4);
    assert.ok(warnings.every((w) => !w.includes('oops') && !w.includes('just text')));
  });
});

describe('mapLimit', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it('returns results in item order and never exceeds the limit', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(ms);
      active--;
      return i * 10;
    });
    assert.deepEqual(out, [0, 10, 20, 30, 40, 50]);
    assert.equal(peak, 3);
  });

  it('runs one at a time with limit 1, and treats a bad limit as 1', async () => {
    for (const limit of [1, 0, undefined, NaN]) {
      let active = 0;
      let peak = 0;
      await mapLimit([1, 2, 3], limit, async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(2);
        active--;
      });
      assert.equal(peak, 1, String(limit));
    }
  });

  it('handles an empty list', async () => {
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  });

  it('rejects with the first error, starts nothing new, and tells stragglers to stop', async () => {
    const started = [];
    const stoppedFlags = [];
    await assert.rejects(
      mapLimit([1, 2, 3, 4, 5, 6], 2, async (n, _i, ctx) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
        await sleep(20);
        stoppedFlags.push(ctx.stopped());
      }),
      /boom/,
    );
    await sleep(40);
    assert.deepEqual(started, [1, 2], 'no new call after the failure');
    assert.deepEqual(stoppedFlags, [true], 'the call still in flight knows it should not record progress');
  });

  it('does not leave unhandled rejections when several calls fail', async () => {
    await assert.rejects(mapLimit([1, 2, 3], 3, async (n) => { await sleep(n); throw new Error(`e${n}`); }), /e1/);
    await sleep(20);
  });
});
