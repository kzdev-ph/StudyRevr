// Superscripts and subscripts in a PDF are separate, smaller text items drawn above or below the baseline, so the
// plain text of a page flattens "10" + "23" into "1023". This reads the position and size pdf.js gives every text
// item and writes the clear cases as Unicode (10²³, H₂O). Anything doubtful is left exactly as it was.

const SUPER = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '–': '⁻', n: 'ⁿ', '(': '⁽', ')': '⁾' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };

const SUPER_TEXT = /^(\s*)([0-9+\-−–n()]+)(\s*)$/;
const SUPER_NEEDS = /[0-9+\-−–n]/; // not just brackets
const SUB_TEXT = /^(\s*)(\d{1,3})(\s*)$/;

const MAX_SCRIPT_SIZE = 0.8; // a script is at most this share of the size of the text it sits on
const MIN_RAISE = 0.25; // ...and a superscript is raised by at least this share of that size
const MIN_LOWER = 0.12; // ...a subscript lowered by at least this
const MAX_OFFSET = 0.8; // further away than this and it is another line, not a script
const MAX_GAP = 0.6; // the script starts within this distance of where the text before it ends

const sizeOf = (t) => Math.hypot(t[2], t[3]);
export const upright = (t) => Array.isArray(t) && t.length >= 6 && Math.abs(t[1]) < 1e-6 && Math.abs(t[2]) < 1e-6 && t[3] > 0;
const mapChars = (digits, table) => [...digits].map((c) => table[c]).join('');

// Takes the text items of one page; returns the text of the page (the items joined, an end-of-line where pdf.js saw one),
// with the clear superscripts and subscripts converted.
export function pageText(items) {
  let base = null; // the last ordinary item on this line: what a script is measured against
  let spaced = false; // a space came after it, so what follows is not attached to it
  let out = '';
  for (const item of items) {
    if (item.str == null) continue;
    let str = item.str;
    const trimmed = str.trim();
    if (trimmed) {
      const converted = base && !spaced && convert(item, base);
      if (converted) str = converted;
      else {
        base = item; // a script is not a base, so a second script is still measured against the text
        spaced = false;
      }
    } else if (str) spaced = true;
    out += str + (item.hasEOL ? '\n' : '');
    if (item.hasEOL) base = null;
  }
  return out;
}

function convert(item, base) {
  const t = item.transform;
  const b = base.transform;
  if (!upright(t) || !upright(b)) return null;
  const size = sizeOf(t);
  const baseSize = sizeOf(b);
  if (size > baseSize * MAX_SCRIPT_SIZE) return null;
  const rise = (t[5] - b[5]) / baseSize;
  if (Math.abs(rise) > MAX_OFFSET) return null;
  const gap = (t[4] - (b[4] + (base.width ?? 0))) / baseSize;
  if (Math.abs(gap) > MAX_GAP) return null;
  if (/\s$/.test(base.str)) return null; // after a space it is not attached to the text before it
  const before = base.str;

  if (rise >= MIN_RAISE) {
    const m = SUPER_TEXT.exec(item.str);
    if (m && SUPER_NEEDS.test(m[2]) && /[\p{L}\d)\]]$/u.test(before)) return m[1] + mapChars(m[2], SUPER) + m[3];
  } else if (rise <= -MIN_LOWER) {
    const m = SUB_TEXT.exec(item.str);
    if (m && /\p{L}$/u.test(before)) return m[1] + mapChars(m[2], SUB) + m[3];
  }
  return null;
}
