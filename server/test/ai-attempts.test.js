import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeAttempt, retryAfterMs } from '../src/ai/client.js';
import { createRateLimiter } from '../src/ai/ratelimit.js';
import { CFG, completion, failure, makeClient, schema, scriptedFetch } from './helpers.js';

const OK = () => completion('{"answer":"ok","n":1}');
const timeout = () => {
  throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
};
const reset = () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
};

// A client on a fake clock: sleeping moves the clock, so request-limit waits are exact and instant.
function clockedClient(fetchImpl, cfg = CFG) {
  let t = 0;
  const sleeps = [];
  const events = [];
  const client = makeClient(fetchImpl, cfg, {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    onAttempt: (e) => events.push({ ...e, at: t }),
  });
  return Object.assign(client, { sleeps, events, ask: (label = 'the test call') => client.generateJSON({ system: 's', user: 'u', schema, label }) });
}
const brief = (events) => events.map((e) => [e.type, e.attempt, e.reason ?? null, e.retry ?? null]);

describe('AI attempt log', () => {
  it('reports start and end of every attempt, and a timeout as a retried failure', async () => {
    const client = clockedClient(scriptedFetch(timeout, OK));
    await client.ask('the flashcards');
    assert.deepEqual(brief(client.events), [
      ['start', 1, null, null],
      ['fail', 1, 'timeout', true],
      ['start', 2, null, null],
      ['ok', 2, null, null],
    ]);
    assert.ok(client.events.every((e) => e.label === 'the flashcards'), 'the call label is on every attempt');
    assert.equal(client.events[1].waitMs, 2000);
    assert.deepEqual({ attempts: client.stats.attempts, failed: client.stats.failedAttempts, retries: client.stats.retries, all: client.stats.httpRetries }, {
      attempts: 2,
      failed: { timeout: 1 },
      retries: { timeout: 1 },
      all: 1,
    });
  });

  it('counts a second timeout as a failure that is not retried', async () => {
    const client = clockedClient(scriptedFetch(timeout));
    await assert.rejects(client.ask(), (err) => err.code === 'timeout');
    assert.deepEqual(brief(client.events).at(-1), ['fail', 2, 'timeout', false]);
    assert.deepEqual(client.stats.failedAttempts, { timeout: 2 });
    assert.deepEqual(client.stats.retries, { timeout: 1 });
  });

  it('names each failure: 429 rate_limit, 5xx server, dropped connection network, other status http_<n>', async () => {
    const client = clockedClient(scriptedFetch(failure(429, 'slow'), failure(503, 'down'), reset, OK));
    await client.ask();
    const fails = client.events.filter((e) => e.type === 'fail');
    assert.deepEqual(fails.map((e) => [e.reason, e.status ?? null]), [
      ['rate_limit', 429],
      ['server', 503],
      ['network', null],
    ]);
    assert.deepEqual(client.stats.retries, { rate_limit: 1, server: 1, network: 1 });

    const bad = clockedClient(scriptedFetch(failure(400, { error: { message: 'bad model' } })));
    await assert.rejects(bad.ask(), (err) => err.code === 'bad_request');
    assert.deepEqual(brief(bad.events).at(-1), ['fail', 1, 'http_400', false]);
  });

  it('a reply whose body stalls is a timeout, and is retried', async () => {
    const stalled = () => ({ ok: true, status: 200, headers: new Headers(), text: async () => timeout() });
    const client = clockedClient(scriptedFetch(stalled, OK));
    assert.deepEqual(await client.ask(), { answer: 'ok', n: 1 });
    assert.deepEqual(client.stats.failedAttempts, { timeout: 1 });
  });

  it('formats events as one log line each', () => {
    assert.equal(describeAttempt({ type: 'start', label: 'the key terms', attempt: 1 }), 'the key terms #1 start');
    assert.equal(describeAttempt({ type: 'ok', label: 'the key terms', attempt: 1, ms: 1930 }), 'the key terms #1 ok 1.9s');
    assert.equal(
      describeAttempt({ type: 'fail', label: 'the flashcards', attempt: 1, ms: 25000, reason: 'timeout', retry: true, waitMs: 2000 }),
      'the flashcards #1 FAIL timeout after 25.0s, retry in 2.0s',
    );
    assert.equal(
      describeAttempt({ type: 'fail', label: 'x', attempt: 5, ms: 300, reason: 'rate_limit', status: 429, retry: false }),
      'x #5 FAIL rate_limit (HTTP 429) after 0.3s, giving up',
    );
    assert.equal(describeAttempt({ type: 'throttle', label: 'x', attempt: 1, waitMs: 4000 }), 'x #1 waited 4.0s for the request limit');
  });
});

describe('429 Retry-After', () => {
  it('reads seconds, an HTTP date, or Google\'s RetryInfo retryDelay in the body', () => {
    assert.equal(retryAfterMs('3'), 3000);
    assert.equal(retryAfterMs('1.5'), 1500);
    assert.equal(retryAfterMs('Wed, 07 Oct 2026 00:00:10 GMT', '', Date.parse('Wed, 07 Oct 2026 00:00:00 GMT')), 10_000);
    const google = JSON.stringify([{ error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] } }]);
    assert.equal(retryAfterMs(null, google), 7000);
    assert.equal(retryAfterMs(null, '{"error":"slow"}'), null);
  });

  it('waits what the body names when there is no header, and at most 60 s', async () => {
    const google = JSON.stringify([{ error: { details: [{ retryDelay: '7s' }] } }]);
    const client = clockedClient(scriptedFetch(failure(429, google), OK));
    await client.ask();
    assert.deepEqual(client.sleeps, [7000]);

    const long = clockedClient(scriptedFetch(failure(429, 'slow', { 'retry-after': '600' }), OK));
    await long.ask();
    assert.deepEqual(long.sleeps, [60_000]);
  });

  it('under a request limit, a 429 holds the other calls to that model too', async () => {
    let n = 0;
    const f = scriptedFetch(() => (++n === 1 ? failure(429, 'slow', { 'retry-after': '10' }) : OK()));
    const client = clockedClient(f, { ...CFG, requestsPerMinute: 15 });
    await client.ask('first');
    await client.ask('second');
    const secondStart = client.events.find((e) => e.label === 'second' && e.type === 'start');
    assert.ok(secondStart.at >= 10_000, `second call started at ${secondStart.at} ms, during the 10 s pause`);
  });
});

describe('client-side request limit', () => {
  it('lets 12 of 15 requests a minute through (3 stay free for live calls) and makes the 13th wait for the oldest to leave the window', async () => {
    const client = clockedClient(scriptedFetch(OK), { ...CFG, requestsPerMinute: 15 });
    await Promise.all(Array.from({ length: 13 }, (_, i) => client.ask(`call ${i + 1}`)));
    const throttles = client.events.filter((e) => e.type === 'throttle');
    assert.deepEqual(throttles.map((e) => [e.label, e.waitMs]), [['call 13', 60_000]]);
    assert.equal(client.stats.throttledMs, 60_000);
    assert.equal(client.stats.attempts, 13);
  });

  it('counts retries against the limit, and does nothing without one', async () => {
    const client = clockedClient(scriptedFetch(failure(503, 'down'), OK), { ...CFG, requestsPerMinute: 1 });
    await client.ask();
    // the retry waits 2 s of backoff, then the rest of the minute for its slot
    assert.deepEqual(client.sleeps, [2000, 58_000]);

    const free = clockedClient(scriptedFetch(OK));
    await Promise.all(Array.from({ length: 30 }, () => free.ask()));
    assert.equal(free.stats.throttledMs, 0);
  });

  it('keeps one window per model', async () => {
    let t = 0;
    const limiter = createRateLimiter({ now: () => t, sleep: async (ms) => void (t += ms) });
    assert.equal(await limiter.acquire('host|a', 1), 0);
    assert.equal(await limiter.acquire('host|b', 1), 0, 'another model has its own slots');
    assert.equal(await limiter.acquire('host|a', 1), 60_000);
    limiter.pause('host|b', t + 5000);
    assert.equal(await limiter.acquire('host|b', 0), 5000, 'a pause holds even without a per-minute limit');
  });
});
