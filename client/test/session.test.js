import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTracker, HEARTBEAT_MS, IDLE_MS } from '../src/lib/session.js';

const SEC = 1000;
const MIN = 60 * SEC;

// A fake clock with timers; advance() runs due timers in time order.
function fakeTime() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    async advance(ms) {
      const until = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await flush();
      }
      t = until;
      await flush();
    },
  };
  return clock;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(opts = {}) {
  const clock = fakeTime();
  const sessions = [];
  const reports = [];
  const tracker = createSessionTracker({
    start: async () => {
      sessions.push(clock.now());
      return sessions.length;
    },
    report: (id, body) => reports.push({ id, ...body }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...opts,
  });
  const ends = () => reports.filter((r) => r.end_reason);
  return { clock, tracker, sessions, reports, ends };
}

describe('session tracker', () => {
  it('counts active time and ends with "left" when the screen closes', async () => {
    const { clock, tracker, sessions, ends } = setup();
    tracker.open();
    await flush();
    await clock.advance(2 * MIN);
    tracker.interaction();
    await clock.advance(MIN);
    tracker.close();
    await flush();
    assert.equal(sessions.length, 1);
    assert.deepEqual(ends(), [{ id: 1, active_ms: 3 * MIN, end_reason: 'left', ended_ago_ms: 0 }]);
    assert.equal(tracker.totalActiveMs(), 3 * MIN);
  });

  it('sends a heartbeat every 30 s, counting only up to the last interaction', async () => {
    const { clock, tracker, reports } = setup();
    tracker.open();
    await clock.advance(10 * SEC);
    tracker.interaction();
    await clock.advance(HEARTBEAT_MS); // t = 40 s
    tracker.interaction();
    await clock.advance(HEARTBEAT_MS); // t = 70 s
    assert.deepEqual(reports.map((r) => r.active_ms), [10 * SEC, 40 * SEC]);
  });

  it('ends after 5 minutes without interaction, at the last interaction; the next tap starts a new session', async () => {
    const { clock, tracker, sessions, ends } = setup();
    tracker.open();
    await clock.advance(MIN);
    tracker.interaction(); // last touch at 1 min
    await clock.advance(IDLE_MS - SEC);
    assert.equal(ends().length, 0, 'not yet: 4:59 idle');
    await clock.advance(SEC);
    assert.deepEqual(ends(), [{ id: 1, active_ms: MIN, end_reason: 'idle', ended_ago_ms: IDLE_MS }]);
    assert.equal(tracker.isOpen(), false);

    await clock.advance(10 * MIN);
    tracker.interaction(); // back: a second session
    await flush();
    assert.equal(sessions.length, 2);
    await clock.advance(30 * SEC);
    tracker.close();
    await flush();
    assert.deepEqual(ends()[1], { id: 2, active_ms: 30 * SEC, end_reason: 'left', ended_ago_ms: 0 });
    assert.equal(tracker.totalActiveMs(), MIN + 30 * SEC);
  });

  it('interactions keep the session alive', async () => {
    const { clock, tracker, ends } = setup();
    tracker.open();
    for (let i = 0; i < 10; i += 1) {
      await clock.advance(4 * MIN);
      tracker.interaction();
    }
    assert.equal(ends().length, 0);
    assert.equal(tracker.totalActiveMs(), 40 * MIN);
  });

  it('pauses in the background and carries on when back within 5 minutes', async () => {
    const { clock, tracker, sessions, reports, ends } = setup();
    tracker.open();
    await clock.advance(2 * MIN);
    tracker.interaction();
    tracker.hide();
    await flush();
    assert.deepEqual(reports.at(-1), { id: 1, active_ms: 2 * MIN }, 'time is sent at once on hide');
    await clock.advance(4 * MIN); // away, not counted; no idle end while away
    assert.equal(ends().length, 0);
    tracker.show();
    await clock.advance(MIN);
    tracker.close();
    await flush();
    assert.equal(sessions.length, 1);
    assert.deepEqual(ends(), [{ id: 1, active_ms: 3 * MIN, end_reason: 'left', ended_ago_ms: 0 }]);
  });

  it('away more than 5 minutes: the session ended when the app went away, and a new one starts on return', async () => {
    const { clock, tracker, sessions, ends } = setup();
    tracker.open();
    await clock.advance(MIN);
    tracker.hide();
    await clock.advance(20 * MIN);
    tracker.interaction(); // ignored while hidden
    tracker.show();
    await flush();
    assert.deepEqual(ends(), [{ id: 1, active_ms: MIN, end_reason: 'background', ended_ago_ms: 20 * MIN }]);
    assert.equal(sessions.length, 2);
    await clock.advance(2 * MIN);
    tracker.close('switched');
    await flush();
    assert.deepEqual(ends()[1], { id: 2, active_ms: 2 * MIN, end_reason: 'switched', ended_ago_ms: 0 });
  });

  it('closing while in the background ends at the moment it went away', async () => {
    const { clock, tracker, ends } = setup();
    tracker.open();
    await clock.advance(MIN);
    tracker.hide();
    await clock.advance(2 * MIN);
    tracker.close();
    await flush();
    assert.deepEqual(ends(), [{ id: 1, active_ms: MIN, end_reason: 'left', ended_ago_ms: 2 * MIN }]);
    tracker.interaction();
    tracker.show();
    await flush();
    assert.equal(ends().length, 1, 'a closed tracker does nothing');
  });

  it('if the server cannot open a session, the next interaction tries again', async () => {
    const clock = fakeTime();
    let calls = 0;
    const tracker = createSessionTracker({
      start: async () => {
        calls += 1;
        if (calls === 1) throw new Error('offline');
        return 7;
      },
      report: () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    tracker.open();
    await flush();
    assert.equal(tracker.isOpen(), false);
    tracker.interaction();
    await flush();
    assert.equal(calls, 2);
    assert.equal(tracker.isOpen(), true);
  });
});
