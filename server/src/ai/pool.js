// Runs `fn(item, index, ctx)` over `items` with at most `limit` calls in flight, and resolves with the results in
// item order. On the first failure it rejects at once with that error and starts no new calls; calls already in
// flight are left to finish quietly. `ctx.stopped()` tells such a straggler it should not record any more progress.
export function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  const width = Math.max(1, Math.min(Math.floor(Number(limit)) || 1, items.length));
  let next = 0;
  let stopped = false;
  const ctx = { stopped: () => stopped };

  return new Promise((resolve, reject) => {
    if (!items.length) return resolve(results);
    let finished = 0;
    const fail = (err) => {
      if (stopped) return;
      stopped = true;
      reject(err);
    };
    const launch = () => {
      if (stopped || next >= items.length) return;
      const index = next++;
      Promise.resolve()
        .then(() => fn(items[index], index, ctx))
        .then((value) => {
          if (stopped) return;
          results[index] = value;
          if (++finished === items.length) return resolve(results);
          launch();
        }, fail);
    };
    for (let i = 0; i < width; i++) launch();
  });
}
