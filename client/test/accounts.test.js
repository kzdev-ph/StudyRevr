import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountStatus } from '../src/lib/accounts.js';

const base = { code: 'P01', test: false, signed_in: false, active_now: false, locked_until: null, must_change_password: false };

describe('accountStatus', () => {
  it('words each state', () => {
    assert.equal(accountStatus(base), 'Signed out');
    assert.equal(accountStatus({ ...base, signed_in: true }), 'Signed in');
    assert.equal(accountStatus({ ...base, signed_in: true, active_now: true }), 'Active now');
    assert.equal(accountStatus({ ...base, must_change_password: true }), 'Must change password');
    assert.match(accountStatus({ ...base, locked_until: '2026-10-05T04:30:00.000Z' }), /^Locked until \d\d:\d\d$/);
    assert.equal(accountStatus({ ...base, test: true, code: 'P00', signed_in: true }), 'Your test login');
  });
  it('a lockout is shown ahead of the other states', () => {
    assert.match(accountStatus({ ...base, signed_in: true, active_now: true, must_change_password: true, locked_until: '2026-10-05T04:30:00.000Z' }), /^Locked/);
  });
});
