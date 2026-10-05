// Loaded before every test file (node --import). Unit tests talk to 127.0.0.1 test servers and to scripted fetch
// stubs; they must never reach a real AI provider (slow, costs quota, and needs a key). Anything else fails loudly.
const realFetch = globalThis.fetch;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    // ENOTFOUND makes the AI client give up at once instead of retrying with real sleeps
    throw Object.assign(new TypeError(`Tests must not reach the network (blocked ${url.origin}); inject a fetch stub`), { cause: { code: 'ENOTFOUND' } });
  }
  return realFetch(input, init);
};
