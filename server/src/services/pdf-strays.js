// Some PDFs lose a few glyphs from a line (the "i" of "Thinking", the "ll" of "carefully") and pdf.js hands them over as
// separate little text items instead, with the line itself left with a space where each one belongs: "Th nk carefu y".
// findStrays finds those items and the gap each one belongs in; applyStrays writes them into the gaps. Anything doubtful
// is skipped, so a clean PDF gives few or none. A short label drawn over a longer line can still look like a stray, so the
// caller (pdf.js) applies the repair only when the document as a whole looks damaged.
import { upright } from './pdf-scripts.js';

const STRAY_TEXT = /^\p{L}{1,3}(?: \p{L}{1,3})?$/u;
const SIZE_TOLERANCE = 0.15; // the host's size is within this share of the stray's
const BASELINE_TOLERANCE = 0.2; // ...and its baseline within this share of the host's size
const MAX_GAP_DISTANCE = 1.5; // the gap is at most this many characters from where the stray sits

const sizeOf = (t) => Math.hypot(t[2], t[3]);
// Left-to-right and upright (pdf-scripts' check, plus a positive x scale: a mirrored item reads the other way) with a usable position.
const readable = (t) => upright(t) && t[0] > 0 && Number.isFinite(t[4]) && Number.isFinite(t[5]);

// Rough width of a character in ems; only the proportions matter, they place the stray along its host line.
function em(c) {
  if (c === ' ') return 0.28;
  if ('ijlI.,:;!\'’‘`'.includes(c)) return 0.25;
  if ('ftr()[]-'.includes(c)) return 0.33;
  if ('mwMW'.includes(c)) return 0.85;
  if (/\p{Lu}/u.test(c)) return 0.68;
  return 0.55;
}

const isStray = (item) => typeof item.str === 'string' && STRAY_TEXT.test(item.str.trim()) && readable(item.transform);

function isHostFor(host, stray, text) {
  if (host === stray || typeof host.str !== 'string' || !readable(host.transform) || !(host.width > 0)) return false;
  if (host.str.length <= text.length + 1) return false;
  const size = sizeOf(stray.transform);
  const hostSize = sizeOf(host.transform);
  if (Math.abs(hostSize - size) > SIZE_TOLERANCE * size) return false;
  if (Math.abs(host.transform[5] - stray.transform[5]) > BASELINE_TOLERANCE * hostSize) return false;
  const x = stray.transform[4];
  return host.transform[4] < x && x < host.transform[4] + host.width;
}

const cased = (c) => c !== undefined && /[\p{Lu}\p{Ll}]/u.test(c);
const lower = (c) => c !== undefined && /\p{Ll}/u.test(c);

// The space the stray belongs in, or -1.
function gapNear(chars, t) {
  let best = -1;
  for (let k = 1; k <= chars.length - 2; k += 1) {
    if (chars[k] !== ' ' || Math.abs(k - t) > MAX_GAP_DISTANCE) continue;
    if (!cased(chars[k - 1]) || !cased(chars[k + 1]) || !(lower(chars[k - 1]) || lower(chars[k + 1]))) continue;
    if (best < 0 || Math.abs(k - t) < Math.abs(best - t)) best = k;
  }
  return best;
}

// Takes the text items of one page; returns [{ stray, host, at }]: item indexes, and the code-point index of the space in
// host.str that the stray belongs in.
export function findStrays(items) {
  // candidate hosts by baseline, so a stray looks only at the lines next to it instead of the whole page; an item of two
  // characters or fewer is never a host (isHostFor), so it is left out up front
  const lines = new Map();
  items.forEach((item, i) => {
    if (typeof item.str !== 'string' || item.str.length <= 2 || !readable(item.transform)) return;
    const key = Math.round(item.transform[5]);
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(i);
  });
  const hostOf = (stray, text) => {
    const size = sizeOf(stray.transform);
    const reach = BASELINE_TOLERANCE * size * (1 + SIZE_TOLERANCE); // the largest baseline gap isHostFor accepts
    const y = stray.transform[5];
    let best = -1; // the first host in page order, as a scan of the whole page would give
    for (let key = Math.round(y - reach); key <= Math.round(y + reach); key += 1) {
      for (const j of lines.get(key) ?? []) {
        if (best >= 0 && j > best) break;
        if (isHostFor(items[j], stray, text)) {
          best = j;
          break;
        }
      }
    }
    return best;
  };

  const byHost = new Map();
  items.forEach((item, i) => {
    if (!isStray(item)) return;
    const host = hostOf(item, item.str.trim());
    if (host >= 0) byHost.set(host, [...(byHost.get(host) ?? []), i]);
  });

  const found = [];
  for (const [hostIndex, strayIndexes] of byHost) {
    const host = items[hostIndex];
    const hostX = host.transform[4];
    const chars = [...host.str];
    const strays = strayIndexes.sort((a, b) => items[a].transform[4] - items[b].transform[4]);
    const strayWidth = strays.reduce((sum, i) => sum + (items[i].width || 0), 0);
    const total = chars.reduce((sum, c) => sum + em(c), 0);
    const scale = Math.max(host.width - strayWidth, 0.5 * host.width) / total;

    let before = 0; // width of this host's earlier strays that were placed
    for (const i of strays) {
      const stray = items[i];
      const d = stray.transform[4] - hostX - before;
      let t = chars.length;
      let acc = 0;
      for (let c = 0; c < chars.length; c += 1) {
        if (acc + (em(chars[c]) * scale) / 2 > d) {
          t = c;
          break;
        }
        acc += em(chars[c]) * scale;
      }
      const at = gapNear(chars, t);
      if (at < 0) continue;
      const near = chars.slice(Math.max(0, Math.floor(t) - 2), Math.ceil(t) + 3).join('');
      if (near.includes(stray.str.trim())) continue; // already there: a faux-bold glyph drawn twice
      found.push({ stray: i, host: hostIndex, at });
      before += stray.width || 0; // only a stray that is put back moves the ones after it
    }
  }
  return found;
}

// Writes each placed stray into its gap, so "Th nk" reads "Think". Takes the page's items and what findStrays gave for them;
// returns a copy: the host's space becomes the letters (several at one gap join in x order), the stray itself an empty string
// that keeps its line break. An item with no placement is returned as it was. Broken words ("sithis") are possible where the
// gap was a guess; only the display suffers, since matching ignores spaces.
export function applyStrays(items, placements) {
  if (!placements.length) return items;
  const out = [...items];
  const byHost = new Map();
  for (const p of placements) byHost.set(p.host, [...(byHost.get(p.host) ?? []), p]);
  for (const [hostIndex, list] of byHost) {
    const chars = [...items[hostIndex].str];
    const atGap = new Map();
    for (const p of list) atGap.set(p.at, [...(atGap.get(p.at) ?? []), p.stray]);
    for (const at of [...atGap.keys()].sort((a, b) => b - a)) {
      const letters = atGap
        .get(at)
        .sort((a, b) => items[a].transform[4] - items[b].transform[4])
        .map((i) => items[i].str.trim())
        .join('');
      chars[at] = letters;
      for (const i of atGap.get(at)) out[i] = { ...items[i], str: '' };
    }
    out[hostIndex] = { ...items[hostIndex], str: chars.join('') };
  }
  return out;
}
