// Client-side request limit per provider host + model (Google's free tier allows ~15 requests per minute). Every HTTP
// attempt takes a slot, retries included, because the provider counts those too. `pause` holds every caller of a key
// until a moment the provider named (a 429's Retry-After), so parallel calls don't keep hitting the limit.
//
// Live calls (a student is waiting: Explain simpler, Filipino/Taglish) go first. A call is live when it passes
// `maxWaitMs`. Live callers jump ahead of everything queued for lesson processing, and processing may not take the last
// few slots of the minute (RESERVE_FRACTION), so a student's tap finds a free slot while a lesson is being processed
// instead of being sent to the backup model.
const WINDOW_MS = 60_000;
const RESERVE_FRACTION = 0.2; // of the per-minute limit, kept free for live calls (15 a minute: 3, so processing gets 12)
const MIN_LIMIT_FOR_RESERVE = 4; // below this there is nothing to spare: every slot is shared

export const reservedSlots = (perMinute) => (perMinute >= MIN_LIMIT_FOR_RESERVE ? Math.max(1, Math.round(perMinute * RESERVE_FRACTION)) : 0);

export function createRateLimiter({ now = Date.now, sleep }) {
  const buckets = new Map(); // key -> { starts: [ms], pausedUntil: ms, waiters: [], pumping, wake }

  const bucket = (key) => {
    if (!buckets.has(key)) buckets.set(key, { starts: [], pausedUntil: 0, waiters: [], pumping: false, wake: null });
    return buckets.get(key);
  };

  const prune = (b) => {
    const t = now();
    while (b.starts.length && b.starts[0] <= t - WINDOW_MS) b.starts.shift();
  };

  // How long a request must wait now for a slot (0: go). Old starts leave the window as time passes. A live request may
  // use every slot of the minute; any other leaves the reserved ones free.
  function waitFor(b, perMinute, live) {
    prune(b);
    const t = now();
    const limit = perMinute > 0 ? (live ? perMinute : perMinute - reservedSlots(perMinute)) : 0;
    const full = limit > 0 && b.starts.length >= limit ? b.starts[b.starts.length - limit] + WINDOW_MS - t : 0;
    return Math.max(0, b.pausedUntil - t, full);
  }

  // Hands out slots one waiter at a time, live ones first. It re-reads the queue after every wait, and a live caller
  // that arrives while it sleeps for a lesson's call wakes it, so the live call is not held up by that wait.
  async function pump(b) {
    if (b.pumping) return;
    b.pumping = true;
    try {
      while (b.waiters.length) {
        const w = b.waiters[0];
        const ms = waitFor(b, w.perMinute, w.live);
        if (ms > 0) {
          const before = now();
          await Promise.race([sleep(ms), new Promise((resolve) => (b.wake = resolve))]);
          b.wake = null;
          w.waited += now() - before;
          continue;
        }
        b.waiters.shift();
        b.starts.push(now());
        w.resolve(w.waited);
      }
    } finally {
      b.pumping = false;
    }
  }

  return {
    // Resolves with the milliseconds waited once a request may start. Callers take slots in order, live ones before
    // the rest. `perMinute` <= 0 or missing means no per-minute limit (a pause still applies).
    // `maxWaitMs` (live calls): resolves with null at once, taking no slot, when the request would have to wait
    // longer than that (the bucket is paused or full, or other live calls are already queued for a full bucket).
    acquire(key, perMinute, { maxWaitMs, live = maxWaitMs !== undefined } = {}) {
      const b = bucket(key);
      if (maxWaitMs !== undefined) {
        prune(b);
        const liveAhead = b.waiters.filter((w) => w.live).length;
        const crowded = perMinute > 0 && b.starts.length + liveAhead >= perMinute;
        if (waitFor(b, perMinute, true) > maxWaitMs || (crowded && liveAhead > 0)) return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        const waiter = { perMinute, live, waited: 0, resolve };
        // after the last live waiter, before the first of the others
        const firstOther = b.waiters.findIndex((w) => !w.live);
        if (live) b.waiters.splice(firstOther === -1 ? b.waiters.length : firstOther, 0, waiter);
        else b.waiters.push(waiter);
        if (live && b.wake) b.wake();
        pump(b);
      });
    },
    pause(key, untilMs) {
      const b = bucket(key);
      b.pausedUntil = Math.max(b.pausedUntil, untilMs);
    },
  };
}
