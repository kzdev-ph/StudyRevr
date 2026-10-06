// Counts and logs every HTTP request this process makes through fetch, whoever makes it (the AI client, a library,
// anything), so the provider's request count can be checked against ours. Only the method, host and path are logged:
// never the query string, headers or body, where keys could be.
export function installNetLog({ target = globalThis, log = (line) => console.error(line), now = Date.now } = {}) {
  const original = target.fetch;
  const stats = { requests: 0, failed: 0, byHost: {} };
  let n = 0;

  const where = (input) => {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      return { host: url.host, path: url.pathname };
    } catch {
      return { host: '(unknown)', path: '' };
    }
  };

  target.fetch = async function loggedFetch(input, init) {
    const id = ++n;
    const { host, path } = where(input);
    const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
    stats.requests += 1;
    stats.byHost[host] = (stats.byHost[host] ?? 0) + 1;
    const started = now();
    log(`[net] #${id} ${method} ${host}${path} sent`);
    try {
      const res = await original.call(this, input, init);
      log(`[net] #${id} ${method} ${host}${path} -> HTTP ${res.status} after ${((now() - started) / 1000).toFixed(1)}s`);
      return res;
    } catch (err) {
      stats.failed += 1;
      log(`[net] #${id} ${method} ${host}${path} -> ${err?.name ?? 'Error'} after ${((now() - started) / 1000).toFixed(1)}s`);
      throw err;
    }
  };

  return {
    stats,
    uninstall() {
      target.fetch = original;
    },
  };
}
