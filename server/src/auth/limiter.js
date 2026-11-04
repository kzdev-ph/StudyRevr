const MAX_KEYS = 5000; // most keys kept at once; the oldest give way beyond this

// A sliding-window limiter kept in memory (a restart clears it): at most `max` counted attempts per key within
// `windowMs`. limited(key, nowMs) answers true when the key is over the limit (that attempt is not counted), else
// counts the attempt and answers false. Keys with no attempt left in the window are swept at most once per window, and
// the map never holds more than MAX_KEYS keys (a flood of new keys pushes out the least recently used ones).
export function createLimiter({ max, windowMs }) {
  const seen = new Map(); // key -> times of its recent attempts, least recently used first
  let sweptAt = -Infinity;
  return {
    limited(key, nowMs) {
      const recent = (seen.get(key) ?? []).filter((at) => nowMs - at < windowMs);
      const over = recent.length >= max;
      seen.delete(key); // re-added below, so insertion order is last-used order
      seen.set(key, over ? recent : [...recent, nowMs]);
      if (nowMs - sweptAt >= windowMs) {
        sweptAt = nowMs;
        for (const [other, times] of seen) if (times.every((at) => nowMs - at >= windowMs)) seen.delete(other);
      }
      while (seen.size > MAX_KEYS) seen.delete(seen.keys().next().value);
      return over;
    },
    // whether the key is over the limit now, without counting an attempt
    over: (key, nowMs) => (seen.get(key) ?? []).filter((at) => nowMs - at < windowMs).length >= max,
    size: () => seen.size,
  };
}

// The key to count an IP under. An IPv6 address is one of a whole /64 that the person controls, so it is grouped by
// that prefix; IPv4 and IPv4-mapped IPv6 (::ffff:1.2.3.4) stay as they are.
export function limiterKey(ip) {
  const text = String(ip ?? '').split('%')[0]; // a zone id (fe80::1%eth0) is not part of the address
  if (!text.includes(':') || /^::ffff:/i.test(text)) return text;
  const [head, tail = ''] = text.split('::');
  const first = head ? head.split(':') : [];
  const last = tail ? tail.split(':') : [];
  const groups = text.includes('::') ? [...first, ...Array(Math.max(0, 8 - first.length - last.length)).fill('0'), ...last] : first;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
