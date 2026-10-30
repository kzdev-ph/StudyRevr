import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// The browser's storage event reaches lib/auth.js through `window`, which node does not have.
const win = new EventTarget();
globalThis.window = win;
const { lockAdmin, setAdminPin, getAdminPin } = await import('../src/lib/admin.js');
const { acceptLogin, getAccount, getToken, markMustChange, onBeforeSignOut, onTokenChange, setAccount, setToken, signOut, signedOutByServer, takeSignedOutNotice } = await import('../src/lib/auth.js');

const realFetch = globalThis.fetch;
let calls;

beforeEach(() => {
  calls = [];
  setToken('t1');
  setAdminPin('1234');
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), token: init.headers?.authorization });
    return { ok: true, status: 204, headers: { get: () => null } };
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
  setToken(null);
  setAccount(null);
  lockAdmin();
  takeSignedOutNotice();
});

describe('signOut', () => {
  it('waits for a slow handler, then tells the server, then forgets the token', async () => {
    const order = [];
    let handlerDone = false;
    const off = onBeforeSignOut(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            handlerDone = true;
            order.push('handler');
            resolve();
          }, 30);
        }),
    );
    const realLogout = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      order.push(`logout after handler: ${handlerDone}, token still set: ${getToken() === 't1'}`);
      return realLogout(url, init);
    };
    setAccount({ email: 'a@b.co', must_change_password: false });
    await signOut();
    off();
    assert.deepEqual(order, ['handler', 'logout after handler: true, token still set: true']);
    assert.equal(calls[0].token, 'Bearer t1');
    assert.match(calls[0].url, /\/auth\/logout$/);
    assert.equal(getToken(), null);
    assert.equal(getAdminPin(), null, 'admin is locked again');
  });

  it('stops waiting for a handler after 2 s', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const off = onBeforeSignOut(() => new Promise(() => {})); // never finishes
    let finished = false;
    const done = signOut().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(1900);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(getToken(), 't1');
    mock.timers.tick(200);
    await done;
    off();
    assert.equal(calls.length, 1);
    assert.equal(getToken(), null);
  });

  it('forgets the token even when the server cannot be reached or the handler fails', async () => {
    const off = onBeforeSignOut(() => {
      throw new Error('boom');
    });
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    await signOut();
    off();
    assert.equal(getToken(), null);
  });
});

describe('signedOutByServer', () => {
  it('goes back to sign-in with the reason, once, and makes no server call', () => {
    signedOutByServer('signed_out_by_admin');
    assert.equal(getToken(), null);
    assert.equal(getAdminPin(), null);
    assert.equal(calls.length, 0);
    assert.match(takeSignedOutNotice(), /teacher signed you out/);
    assert.equal(takeSignedOutNotice(), null);
  });
  it('has a text for each reason and a plain one for the rest', () => {
    signedOutByServer('signed_out_elsewhere');
    assert.match(takeSignedOutNotice(), /another device/);
    setToken('t1');
    signedOutByServer('password_reset');
    assert.match(takeSignedOutNotice(), /reset your password/);
    setToken('t1');
    signedOutByServer('session_unknown');
    assert.equal(takeSignedOutNotice(), 'Please sign in again.');
  });
  it('does nothing when nobody is signed in, or the refused token is an old one', () => {
    signedOutByServer('session_unknown', 'old');
    assert.equal(getToken(), 't1');
    assert.equal(takeSignedOutNotice(), null);
    setToken(null);
    signedOutByServer('session_unknown');
    assert.equal(takeSignedOutNotice(), null);
  });
});

describe('the token', () => {
  const storage = (key) => Object.assign(new Event('storage'), { key });
  it('a storage event for the token notifies subscribers, so every tab follows', () => {
    let heard = 0;
    const off = onTokenChange(() => heard++);
    win.dispatchEvent(storage('studyrevr.auth-token'));
    off();
    assert.equal(heard, 1);
  });
  it('a storage event for another key is ignored', () => {
    let heard = 0;
    const off = onTokenChange(() => heard++);
    win.dispatchEvent(storage('studyrevr.theme'));
    off();
    assert.equal(heard, 0);
  });
  it('the account in memory is dropped then, to be read again for the new login', () => {
    setAccount({ email: 'a@b.co', must_change_password: false });
    win.dispatchEvent(storage('studyrevr.auth-token'));
    assert.equal(getAccount(), null);
  });
  it('acceptLogin keeps the new token and account; markMustChange flags the account', () => {
    acceptLogin({ token: 't9', account: { email: 'a@b.co', must_change_password: false } });
    assert.equal(getToken(), 't9');
    assert.equal(getAccount().email, 'a@b.co');
    markMustChange();
    assert.deepEqual(getAccount(), { email: 'a@b.co', must_change_password: true });
  });
});
