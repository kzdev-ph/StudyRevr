import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, api } from '../src/lib/api.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const answer = (status, body) => async () => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api errors', () => {
  it('carries the server message and the developer hint', async () => {
    globalThis.fetch = answer(502, { error: { code: 'auth', message: 'The AI provider rejected the API key. Check the key, then retry.', hint: 'Set GOOGLE_API_KEY in the .env file.' } });
    await assert.rejects(api.simplifySection(1), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.message, 'The AI provider rejected the API key. Check the key, then retry.');
      assert.equal(err.hint, 'Set GOOGLE_API_KEY in the .env file.');
      assert.equal(err.status, 502);
      return true;
    });
  });

  it('has no hint when the server sends none', async () => {
    globalThis.fetch = answer(404, { error: { message: 'Lesson not found.' } });
    await assert.rejects(api.getLesson(9), (err) => err.hint === null && err.message === 'Lesson not found.');
  });

  it('says the server is unreachable, with no hint, when the dev proxy answers without a body', async () => {
    globalThis.fetch = async () => new Response('Bad gateway', { status: 502 });
    await assert.rejects(api.listLessons(), (err) => /Can't reach the StudyRevr server/.test(err.message) && err.hint === null);
  });

  it('says the server is unreachable when the request itself fails', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(api.listLessons(), (err) => /Can't reach the StudyRevr server/.test(err.message));
  });
});
