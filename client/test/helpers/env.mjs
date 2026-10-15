// A browser for the screen tests: jsdom plus a fake clock. Time only moves when `advance()` is called, one millisecond
// at a time, with a frame every 16 ms, so a run is the same every time. Import this FIRST (motion reads
// requestAnimationFrame when it loads). `REDUCED=1` in the environment turns prefers-reduced-motion on.
import { JSDOM } from 'jsdom';
import { setImmediate as realImmediate } from 'node:timers';

export const reduced = process.env.REDUCED === '1';
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const w = dom.window;

export const sched = { t: 1000, timers: new Map(), id: 1, rafs: [], hidden: false };
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

// every DOM class jsdom has (NodeList, HTMLElement, SVGElement, Event...) that node does not already have
for (const name of Object.getOwnPropertyNames(w)) {
  if (/^[A-Z]/.test(name) && !(name in globalThis)) define(name, w[name]);
}
define('localStorage', w.localStorage);
define('sessionStorage', w.sessionStorage);
define('window', w);
define('document', w.document);
define('navigator', w.navigator);
define('getComputedStyle', w.getComputedStyle.bind(w));
define('IS_REACT_ACT_ENVIRONMENT', true);
w.Element.prototype.scrollIntoView = () => {}; // jsdom does not scroll
w.matchMedia = (query) => ({
  matches: reduced && /prefers-reduced-motion/.test(query),
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
define('matchMedia', w.matchMedia);
Object.defineProperty(w.document, 'visibilityState', { get: () => (sched.hidden ? 'hidden' : 'visible'), configurable: true });

define('performance', { now: () => sched.t, timeOrigin: 0 });
define('requestAnimationFrame', (cb) => {
  const id = sched.id++;
  sched.rafs.push([id, cb]);
  return id;
});
define('cancelAnimationFrame', (id) => {
  sched.rafs = sched.rafs.filter(([k]) => k !== id);
});
define('setTimeout', (fn, ms = 0) => {
  const id = sched.id++;
  sched.timers.set(id, { at: sched.t + Math.max(0, ms), fn });
  return id;
});
define('clearTimeout', (id) => sched.timers.delete(id));
w.requestAnimationFrame = globalThis.requestAnimationFrame;
w.cancelAnimationFrame = globalThis.cancelAnimationFrame;
w.setTimeout = globalThis.setTimeout;
w.clearTimeout = globalThis.clearTimeout;

// What fires at the current millisecond: due timers, then (every 16 ms) the animation frames.
function due() {
  const fire = [];
  for (const [id, timer] of sched.timers) {
    if (timer.at <= sched.t) {
      sched.timers.delete(id);
      fire.push(timer.fn);
    }
  }
  if (sched.t % 16 === 0) {
    const frames = sched.rafs;
    sched.rafs = [];
    for (const [, cb] of frames) fire.push(() => cb(sched.t));
  }
  return fire;
}

const yieldReal = () => new Promise((resolve) => realImmediate(resolve));

// Move the clock on `ms` milliseconds, letting React and pending promises settle at every step something fires.
export async function advance(act, ms) {
  for (let i = 0; i < ms; i += 1) {
    sched.t += 1;
    const fire = due();
    if (fire.length) {
      await act(async () => {
        for (const fn of fire) fn();
      });
      await yieldReal();
    }
  }
}

// Step on, one millisecond at a time, until `test()` is true (or give up).
export async function until(act, test, limit = 8000) {
  for (let i = 0; i < limit; i += 1) {
    if (test()) return true;
    await advance(act, 1);
  }
  return test();
}

export const settle = async (act) => {
  await act(async () => {});
  await yieldReal();
};
