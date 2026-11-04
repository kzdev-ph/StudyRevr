import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { storedValue } from '../src/lib/store.js';

// A Storage stand-in shared by two "tabs" (two storedValue instances), as localStorage is.
function fakeStorage({ refuseWrites = false } = {}) {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (refuseWrites) throw new Error('QuotaExceededError');
      data.set(k, String(v));
    },
    removeItem: (k) => data.delete(k),
  };
}

describe('storedValue', () => {
  it('a value another tab removed reads as gone, not as this tab’s old copy', () => {
    const storage = fakeStorage();
    const tabA = storedValue('k', () => storage);
    const tabB = storedValue('k', () => storage);
    tabA.set('t1');
    assert.equal(tabB.get(), 't1');
    tabB.set(null); // signed out in tab B
    assert.equal(tabA.get(), null);
  });

  it('keeps the value in memory when storage refuses writes or is missing', () => {
    const refusing = storedValue('k', () => fakeStorage({ refuseWrites: true }));
    refusing.set('t1');
    assert.equal(refusing.get(), 't1');
    const none = storedValue('k', () => null);
    none.set('t2');
    assert.equal(none.get(), 't2');
  });
});
