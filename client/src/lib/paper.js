// Pure helpers for the paper motion (unit-tested in client/test).

export const RIFFLE_MS = 600;

// The deck coming out at the start of a flashcard deck: 3 or 4 riffles of RIFFLE_MS each (1.8 or 2.4 s), picked at
// random each time. `random` is Math.random in the app and fixed in tests.
export function shufflePlan(random = Math.random) {
  const riffles = random() < 0.5 ? 3 : 4;
  return { riffles, ms: riffles * RIFFLE_MS };
}

// One card's keyframes for `riffles` riffles: each riffle splits the deck left and right and pushes it back together,
// the halves changing places on the way back (zIndex), every other riffle the other way round and a little shorter.
// `i` is the card's place in the pile (0 at the bottom) of `n` cards. -> { x, y, rotate, zIndex, times }
export function riffleFrames(i, n, riffles) {
  const side = i % 2 ? 1 : -1;
  const y0 = -i * 3;
  const r0 = (i - (n - 1) / 2) * 1.5;
  const f = { x: [0], y: [y0], rotate: [r0], zIndex: [i], times: [0] };
  let z = i;
  for (let r = 0; r < riffles; r += 1) {
    const dir = r % 2 ? -side : side;
    const reach = r % 2 ? 60 : 78;
    f.x.push(dir * reach, 0);
    f.y.push(y0 - 10, y0);
    f.rotate.push(dir * 9, r0);
    const swapped = n - 1 - z;
    f.zIndex.push(z, swapped);
    z = swapped;
    f.times.push((r + 0.5) / riffles, (r + 1) / riffles);
  }
  return f;
}

// A hand-drawn loop round a w x h box, in its own pixels: a little more than one turn, slightly tilted, ending past
// where it began, the way a pen circles an answer. -> an SVG path (cubic curves through the points).
export function loopPath(w, h, { turns = 1.12, tilt = -0.07, start = -0.9 } = {}) {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2 - 2;
  const ry = h / 2 - 2;
  const n = 36;
  const pts = [];
  for (let k = 0; k <= n; k += 1) {
    const t = k / n;
    const a = start - t * turns * Math.PI * 2;
    const wobble = 1 + 0.035 * Math.sin(t * 9) + (t > 0.85 ? (t - 0.85) * 0.5 : 0);
    const x = Math.cos(a) * rx * wobble;
    const y = Math.sin(a) * ry * wobble;
    pts.push([cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)]);
  }
  const p = (q) => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
  let d = `M${p(pts[0])}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    d += ` C${p([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6])} ${p([p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6])} ${p(p2)}`;
  }
  return d;
}
