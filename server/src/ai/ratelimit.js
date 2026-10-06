// Client-side request limit per provider host + model (Google's free tier allows ~15 requests per minute). Every HTTP
// attempt takes a slot, retries included, because the provider counts those too. `pause` holds every caller of a key
// until a moment the provider named (a 429's Retry-After), so parallel calls don't keep hitting the limit.
const WINDOW_MS = 60_000;

export function createRateLimiter({ now = Date.now, sleep }) {
  const buckets = new Map(); // key -> { starts: [ms], pausedUntil: ms, tail: Promise }

  const bucket = (key) => {
    if (!buckets.has(key)) buckets.set(key, { starts: [], pausedUntil: 0, tail: Promise.resolve() });
    return buckets.get(key);
  };

  // How long a request must wait now for a slot (0: go). Old starts leave the window as time passes.
  function waitFor(b, perMinute) {
    const t = now();
    while (b.starts.length && b.starts[0] <= t - WINDOW_MS) b.starts.shift();
    const full = perMinute > 0 && b.starts.length >= perMinute ? b.starts[0] + WINDOW_MS - t : 0;
    return Math.max(0, b.pausedUntil - t, full);
  }

  return {
    // Resolves with the milliseconds waited once a request may start. Callers queue per key, so concurrent calls
    // take slots in order. `perMinute` <= 0 or missing means no per-minute limit (a pause still applies).
    acquire(key, perMinute) {
      const b = bucket(key);
      const turn = b.tail.then(async () => {
        let waited = 0;
        for (let ms = waitFor(b, perMinute); ms > 0; ms = waitFor(b, perMinute)) {
          await sleep(ms);
          waited += ms;
        }
        b.starts.push(now());
        return waited;
      });
      b.tail = turn.catch(() => {});
      return turn;
    },
    pause(key, untilMs) {
      const b = bucket(key);
      b.pausedUntil = Math.max(b.pausedUntil, untilMs);
    },
  };
}
