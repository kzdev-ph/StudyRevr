import { HttpError } from '../middleware/errors.js';

// Participant codes: "P" and a number, written with at least two digits (P01, P07, P12, P100). Typing "p7", "P 7" or
// "P007" all mean P07, so one student can't end up with two codes.
const CODE = /^P\s*-?\s*(\d{1,3})$/i;
const MAX_ADD = 200;

export const UNKNOWN_CODE = "That code isn't on the list. Check with your teacher.";

// -> 'P07', or null when the text isn't a participant code.
export function normalizeCode(text) {
  const m = CODE.exec(String(text ?? '').trim());
  return m ? `P${String(Number(m[1])).padStart(2, '0')}` : null;
}

// "P01-P10, P12 p15" -> ['P01', ..., 'P10', 'P12', 'P15'] (in order, no repeats). Throws a 400 naming the first
// token that isn't a code or a range.
export function parseCodeList(text) {
  const tokens = String(text ?? '').replace(/\bP\s+(?=\d)/gi, 'P').replace(/\s*(?:-|–|\bto\b)\s*/gi, '-').split(/[\s,;]+/).filter(Boolean);
  const codes = [];
  for (const token of tokens) {
    const range = /^(P\d+)-(P?\d+)$/i.exec(token);
    if (range) {
      const [from, to] = [normalizeCode(range[1]), normalizeCode(/^p/i.test(range[2]) ? range[2] : `P${range[2]}`)];
      if (!from || !to) throw new HttpError(400, `"${token}" is not a range of codes like P01-P10.`);
      const [a, b] = [Number(from.slice(1)), Number(to.slice(1))];
      if (b < a) throw new HttpError(400, `"${token}" runs backwards; write it as ${to}-${from}.`);
      if (b - a + 1 > MAX_ADD) throw new HttpError(400, `Add at most ${MAX_ADD} codes at a time.`);
      for (let n = a; n <= b; n += 1) codes.push(`P${String(n).padStart(2, '0')}`);
      continue;
    }
    const code = normalizeCode(token);
    if (!code) throw new HttpError(400, `"${token}" is not a participant code. Codes look like P01.`);
    codes.push(code);
  }
  const unique = [...new Set(codes)];
  if (!unique.length) throw new HttpError(400, 'Type one or more codes, like P01 or P01-P10.');
  if (unique.length > MAX_ADD) throw new HttpError(400, `Add at most ${MAX_ADD} codes at a time.`);
  return unique;
}

// -> { id, code, created_at } or null
export function findParticipant(db, text) {
  const code = normalizeCode(text);
  return code ? db.prepare('SELECT id, code, created_at FROM participants WHERE code = ?').get(code) ?? null : null;
}

// Adds the codes that don't exist yet. -> { added: [...], existing: [...] }
export function addParticipants(db, codes, now = new Date()) {
  return db.transaction(() => {
    const insert = db.prepare('INSERT OR IGNORE INTO participants (code, created_at) VALUES (?, ?)');
    const added = [];
    const existing = [];
    for (const code of codes) (insert.run(code, now.toISOString()).changes ? added : existing).push(code);
    return { added, existing };
  })();
}
