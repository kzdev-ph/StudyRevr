import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, limiterKey } from '../src/auth/limiter.js';

describe('createLimiter', () => {
  it('counts up to max within the window and then refuses without counting', () => {
    const limiter = createLimiter({ max: 2, windowMs: 1000 });
    assert.equal(limiter.limited('a', 0), false);
    assert.equal(limiter.limited('a', 10), false);
    assert.equal(limiter.limited('a', 20), true);
    assert.equal(limiter.limited('b', 20), false);
    assert.equal(limiter.limited('a', 1005), false, 'the first attempt has left the window');
  });

  it('keeps at most 5000 keys: a flood of new ones pushes out the oldest, not the recent', () => {
    const limiter = createLimiter({ max: 1, windowMs: 60_000 });
    for (let i = 0; i < 6000; i++) limiter.limited(`k${i}`, i);
    assert.equal(limiter.size(), 5000);
    assert.equal(limiter.limited('k5999', 6000), true, 'the newest is still counted');
    assert.equal(limiter.limited('k0', 6000), false, 'the oldest was forgotten');
  });

  it('sweeps keys with nothing left in the window, once per window rather than on every call', () => {
    const limiter = createLimiter({ max: 5, windowMs: 1000 });
    for (let i = 0; i < 100; i++) limiter.limited(`old${i}`, 0);
    assert.equal(limiter.size(), 100);
    limiter.limited('mid', 500); // inside the window of the last sweep (at 0): no sweep
    assert.equal(limiter.size(), 101);
    limiter.limited('new', 1200); // a window later: the old keys go; 'mid' (500) is still inside its window
    assert.equal(limiter.size(), 2);
  });
});

describe('limiterKey', () => {
  it('leaves IPv4 and IPv4-mapped IPv6 as they are', () => {
    assert.equal(limiterKey('203.0.113.9'), '203.0.113.9');
    assert.equal(limiterKey('::ffff:203.0.113.9'), '::ffff:203.0.113.9');
    assert.equal(limiterKey('::FFFF:203.0.113.9'), '::FFFF:203.0.113.9');
  });

  it('groups IPv6 by its first 64 bits, however it is written', () => {
    const key = limiterKey('2001:db8:1:2::1');
    assert.equal(key, '2001:db8:1:2::/64');
    for (const ip of ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:0DB8:0001:0002:0:0:0:9', '2001:db8:1:2::', '2001:db8:1:2:3::4%eth0']) assert.equal(limiterKey(ip), key, ip);
    assert.notEqual(limiterKey('2001:db8:1:3::1'), key);
    assert.notEqual(limiterKey('2001:db8:2:2::1'), key);
  });

  it('handles a leading :: and the loopback', () => {
    assert.equal(limiterKey('::1'), '0:0:0:0::/64');
    assert.equal(limiterKey('::2:3:4:5:6'), '0:0:0:2::/64');
    assert.equal(limiterKey('fe80::1'), 'fe80:0:0:0::/64');
  });

  it('copes with a missing address', () => {
    assert.equal(limiterKey(undefined), '');
  });
});
