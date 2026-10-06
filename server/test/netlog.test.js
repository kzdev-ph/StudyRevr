import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAiClient } from '../src/ai/client.js';
import { installNetLog } from '../src/ai/netlog.js';
import { CFG, completion, failure, schema } from './helpers.js';

// A stand-in for globalThis: its fetch answers from a script, so nothing reaches the network.
function fakeTarget(...steps) {
  let i = 0;
  return {
    fetch: async () => {
      const step = steps[Math.min(i++, steps.length - 1)];
      return typeof step === 'function' ? step() : step.clone();
    },
  };
}

describe('installNetLog', () => {
  it('counts and logs every request with method, host and path, never the query string', async () => {
    const target = fakeTarget(new Response('{}', { status: 200 }));
    const lines = [];
    const net = installNetLog({ target, log: (l) => lines.push(l), now: () => 0 });
    await target.fetch('https://example.test/v1/models?key=AIza-SECRET');
    await target.fetch(new URL('https://other.test/x'), { method: 'post' });
    assert.deepEqual(net.stats, { requests: 2, failed: 0, byHost: { 'example.test': 1, 'other.test': 1 } });
    assert.deepEqual(lines, [
      '[net] #1 GET example.test/v1/models sent',
      '[net] #1 GET example.test/v1/models -> HTTP 200 after 0.0s',
      '[net] #2 POST other.test/x sent',
      '[net] #2 POST other.test/x -> HTTP 200 after 0.0s',
    ]);
    assert.ok(lines.every((l) => !l.includes('SECRET')));
  });

  it('logs a request that gets no reply, and uninstall restores fetch', async () => {
    const target = fakeTarget(() => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    });
    const original = target.fetch;
    const lines = [];
    const net = installNetLog({ target, log: (l) => lines.push(l), now: () => 0 });
    await assert.rejects(target.fetch('https://example.test/v1/chat/completions', { method: 'POST' }));
    assert.equal(net.stats.failed, 1);
    assert.match(lines.at(-1), /#1 POST example\.test\/v1\/chat\/completions -> TimeoutError/);
    net.uninstall();
    assert.equal(target.fetch, original);
  });

  it('sees the same number of requests as the AI client counts attempts, retries included', async () => {
    const target = fakeTarget(failure(503, 'down'), failure(429, 'slow'), completion('{"answer":"ok","n":1}'));
    const net = installNetLog({ target, log: () => {} });
    const client = createAiClient({ getConfig: () => CFG, fetchImpl: target.fetch, sleep: async () => {}, log: { warn() {} } });
    await client.generateJSON({ system: 's', user: 'u', schema });
    assert.equal(net.stats.requests, 3);
    assert.equal(client.stats.attempts, net.stats.requests);
  });
});
