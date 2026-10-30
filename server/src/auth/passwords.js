import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
// No 0/o, 1/l/i: a temporary password is read out or typed from a note
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const b64 = (buf) => buf.toString('base64url');
// The same typed password can arrive composed or decomposed (an "ñ" from different keyboards): hash one form.
const normal = (pw) => String(pw).normalize('NFC');

// Stored as scrypt$N$r$p$<salt>$<hash>, so the cost can change later without breaking old hashes.
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(normal(pw), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(pw, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (!salt.length || !expected.length) return false;
  try {
    const actual = await scrypt(normal(pw), salt, expected.length, { N: n, r, p });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// An unknown email still costs one scrypt run, so the answer does not reveal whether the email exists. The dummy hash is
// started at import (not on the first unknown email, which would answer slower than the rest) and awaited when used.
const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));
export async function verifyDummy(pw) {
  await verifyPassword(pw, await dummyHash);
  return false;
}

export function temporaryPassword() {
  return Array.from({ length: 10 }, () => TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)]).join('');
}
