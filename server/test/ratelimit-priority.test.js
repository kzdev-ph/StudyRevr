import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, reservedSlots } from '../src/ai/ratelimit.js';

// Live calls (a student waiting) go before lesson processing (Phase 7B): they are served ahead of queued processing
// calls, and processing may not use the last few slots of the minute.
const fake = () => {
  const c = { t: 1_000_000, slept: [] };
  c.limiter = createRateLimiter({ now: () => c.t, sleep: async (ms) => void (c.slept.push(ms), (c.t += ms)) });
  return c;
};

describe('limiter priority', () => {
  it('keeps a fifth of the slots (at least 1) free for live calls, and none when the limit is tiny', () => {
    assert.equal(reservedSlots(15), 3);
    assert.equal(reservedSlots(30), 6);
    assert.equal(reservedSlots(8), 2);
    assert.equal(reservedSlots(4), 1);
    assert.equal(reservedSlots(3), 0);
    assert.equal(reservedSlots(1), 0);
    assert.equal(reservedSlots(0), 0);
  });

  it('processing calls stop at the reserve; a live call still gets the free slots at once', async () => {
    const { limiter } = fake();
    for (let i = 0; i < 12; i += 1) assert.equal(await limiter.acquire('k', 15), 0);
    // a 13th processing call would have to wait for the window, but a live call takes a reserved slot now
    assert.equal(await limiter.acquire('k', 15, { maxWaitMs: 3000 }), 0);
    assert.equal(await limiter.acquire('k', 15, { maxWaitMs: 3000 }), 0);
    assert.equal(await limiter.acquire('k', 15, { maxWaitMs: 3000 }), 0);
    // now all 15 are used: a live call is refused at once
    assert.equal(await limiter.acquire('k', 15, { maxWaitMs: 3000 }), null);
  });

  it('a live call is not refused because processing calls are queued, and goes before them', async () => {
    const c = fake();
    const order = [];
    for (let i = 0; i < 12; i += 1) await c.limiter.acquire('k', 15); // the lesson's share of the minute is used up
    const queued = [1, 2].map((n) => c.limiter.acquire('k', 15).then((w) => order.push(`lesson ${n} (${w})`)));
    const live = c.limiter.acquire('k', 15, { maxWaitMs: 3000 }).then((w) => order.push(`live (${w})`));
    await Promise.all([...queued, live]);
    assert.equal(order[0], 'live (0)', 'the live call went first, without waiting');
    assert.match(order[1], /^lesson 1/);
    assert.match(order[2], /^lesson 2/);
  });

  it('a live call that arrives while a lesson call sleeps wakes the queue', async () => {
    const c = fake();
    for (let i = 0; i < 12; i += 1) await c.limiter.acquire('k', 15);
    const lesson = c.limiter.acquire('k', 15); // sleeps ~60 s for the window
    await Promise.resolve();
    const live = await c.limiter.acquire('k', 15, { maxWaitMs: 3000 });
    assert.equal(live, 0);
    await lesson;
  });

  it('live calls still queue behind each other and fail fast once the bucket is full', async () => {
    const { limiter } = fake();
    for (let i = 0; i < 15; i += 1) assert.equal(await limiter.acquire('k', 15, { maxWaitMs: 3000 }), 0);
    assert.equal(await limiter.acquire('k', 15, { maxWaitMs: 3000 }), null);
  });

  it('a pause still holds live calls', async () => {
    const c = fake();
    c.limiter.pause('k', c.t + 30_000);
    assert.equal(await c.limiter.acquire('k', 15, { maxWaitMs: 3000 }), null);
  });
});
