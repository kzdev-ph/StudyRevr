import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.js';

export const ADMIN_HEADER = 'x-admin-pin';
const MAX_TRIES = 5;
const LOCK_MS = 60_000;

const digest = (text) => createHash('sha256').update(String(text)).digest();

// The researcher's admin area (lesson upload, participant codes, AI settings, research export) is behind ADMIN_PIN
// from .env, checked here on the server. No PIN set: admin is off (403). A missing or wrong PIN is a 401; after
// MAX_TRIES wrong PINs from one address, that address waits LOCK_MS (429). `clock` is () => ms (tests pass a fake).
export function createAdminGuard({ pin, clock = Date.now } = {}) {
  const expected = pin ? digest(pin) : null;
  const failures = new Map(); // address -> { count, lockedUntil }

  return function requireAdmin(req, _res, next) {
    if (!expected) return next(new HttpError(403, 'Admin is turned off. Set ADMIN_PIN in .env and restart the server.', { code: 'admin_off' }));
    const who = req.ip ?? 'unknown';
    const now = clock();
    const record = failures.get(who);
    if (record?.lockedUntil > now) {
      const seconds = Math.ceil((record.lockedUntil - now) / 1000);
      return next(new HttpError(429, `Too many wrong PINs. Try again in ${seconds} s.`, { code: 'admin_locked' }));
    }
    const given = req.get(ADMIN_HEADER);
    // compare fixed-length digests, so the time taken says nothing about the PIN
    if (given && timingSafeEqual(digest(given), expected)) {
      failures.delete(who);
      return next();
    }
    if (given) {
      const count = (record && !(record.lockedUntil > 0) ? record.count : 0) + 1;
      failures.set(who, count >= MAX_TRIES ? { count: 0, lockedUntil: now + LOCK_MS } : { count, lockedUntil: 0 });
    }
    return next(new HttpError(401, given ? 'That PIN is not right.' : 'Enter the admin PIN.', { code: 'admin_pin' }));
  };
}
