import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAdminPin, lockAdmin, setAdminPin } from '../src/lib/admin.js';
import { api } from '../src/lib/api.js';
import { getToken, setToken, signOut, takeSignedOutNotice } from '../src/lib/auth.js';

// The admin PIN is sent only by calls made for admin. A student on a tab where admin was unlocked must still be just a
// student: no private uploads of others, no owner codes, no teacher uploads. Every `api` function is listed here, so a
// new one has to be classified (the last test fails until it is).

// always admin: they send the PIN
const ADMIN = [
  'listLessonsWithCounts', 'shareLesson', 'makeQuizOptions', 'reviewQuiz', 'lessonLeaks', 'regenerateCard', 'prepareVersions', 'makeFlashcards',
  'adminParticipants', 'adminAccounts', 'resetPassword', 'signOutAccount', 'setTestLogin', 'adminStats', 'appSettings', 'saveAppSettings', 'aiSettings', 'saveAiSettings', 'aiModels',
  'testAi', 'aiProblems', 'deleteStudentKeys', 'downloadBackup', 'lastBackup', 'downloadExport',
];
// admin only when called with { admin: true } (the student's own use of the same route sends none)
const EITHER = ['getLesson', 'uploadLesson', 'retryLesson', 'deleteLesson'];
// student calls: never the PIN
const STUDENT = [
  'listLessons', 'getStatus', 'myUploads', 'simplifySection', 'translateSection', 'saveProgress', 'listDecks', 'getDue', 'answerCard',
  'undoAnswer', 'listQuizzes', 'startQuiz', 'answerQuestion', 'finishQuiz', 'signup', 'login', 'logout', 'me', 'changePassword', 'startSession', 'reportSession', 'logEvent',
  'logSettingEvent', 'getStats', 'myAi', 'myAiModels', 'saveMyKey', 'removeMyKey',
];
// sends the PIN it is given (to check it), not the stored one
const OWN_PIN = ['unlockAdmin'];

const realFetch = globalThis.fetch;
let seen;

beforeEach(() => {
  seen = [];
  setToken('t1');
  setAdminPin('1234');
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers ?? {} });
    return { ok: true, status: 200, json: async () => ({}), headers: { get: () => null }, blob: async () => ({}) };
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  lockAdmin();
  setToken(null);
  takeSignedOutNotice();
});

// downloads give up after the request (there is no page to save a file into); the headers are already recorded
const call = async (name, ...args) => {
  seen = [];
  try {
    await api[name](...args);
  } catch {
    // only the request matters here
  }
  assert.ok(seen.length >= 1, `${name} made no request`);
  return seen[0].headers;
};
const args = (name) => (name === 'uploadLesson' ? [new Blob(['x'])] : [{}, {}]);

describe('the admin PIN header', () => {
  it('is sent by every admin call', async () => {
    for (const name of ADMIN) assert.equal((await call(name, ...args(name)))['x-admin-pin'], '1234', name);
  });
  it('is never sent by a student call', async () => {
    for (const name of STUDENT) {
      const headers = await call(name, ...args(name));
      assert.equal(headers['x-admin-pin'], undefined, name);
      assert.equal(headers.authorization, 'Bearer t1', `${name} still says who is studying`);
      assert.equal(headers['x-participant'], undefined, name);
    }
  });
  it('is sent by the shared routes only when the call is for admin', async () => {
    for (const name of EITHER) {
      const plain = name === 'uploadLesson' ? [new Blob(['x'])] : [7];
      assert.equal((await call(name, ...plain))['x-admin-pin'], undefined, `${name} as a student`);
      const forAdmin = name === 'getLesson' ? [7, undefined, { admin: true }] : name === 'uploadLesson' ? [new Blob(['x']), { admin: true }] : [7, { admin: true }];
      assert.equal((await call(name, ...forAdmin))['x-admin-pin'], '1234', `${name} for admin`);
    }
  });
  it('is sent with no login token', async () => {
    for (const name of ADMIN) assert.equal((await call(name, ...args(name))).authorization, undefined, name);
    const forAdmin = await call('getLesson', 7, undefined, { admin: true });
    assert.equal(forAdmin.authorization, undefined);
    assert.equal(forAdmin['x-participant'], undefined);
  });
  it('is not stored with the student: a student request after unlocking carries none', async () => {
    assert.equal(getAdminPin(), '1234');
    const headers = await call('listLessons');
    assert.equal(headers['x-admin-pin'], undefined);
    assert.equal(headers.authorization, 'Bearer t1');
  });
  it('classifies every api function', () => {
    const listed = [...ADMIN, ...EITHER, ...STUDENT, ...OWN_PIN].sort();
    assert.deepEqual(Object.keys(api).sort(), listed);
    assert.equal(new Set(listed).size, listed.length, 'a function is in two lists');
  });
});

describe('Sign out', () => {
  it('locks admin again and forgets the token', async () => {
    assert.equal(getAdminPin(), '1234');
    await signOut();
    assert.equal(getAdminPin(), null);
    assert.equal(getToken(), null);
  });
  it('leaves a later student request with the new token and without the PIN', async () => {
    await signOut();
    setToken('t2');
    const headers = await call('listLessons');
    assert.equal(headers['x-admin-pin'], undefined);
    assert.equal(headers.authorization, 'Bearer t2');
  });
  it('tells the server, with the token, before it forgets it', async () => {
    await signOut();
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/auth\/logout$/);
    assert.equal(seen[0].headers.authorization, 'Bearer t1');
  });
});

describe('a refused login token', () => {
  const refuse = (status, code) => {
    globalThis.fetch = async () => ({ ok: false, status, json: async () => ({ error: { message: 'No.', code } }), headers: { get: () => null } });
  };
  it('sends the student back to sign-in with the reason', async () => {
    refuse(401, 'signed_out_elsewhere');
    await assert.rejects(api.listLessons());
    assert.equal(getToken(), null);
    assert.equal(getAdminPin(), null, 'admin is locked with it');
    assert.match(takeSignedOutNotice(), /another device/);
    assert.equal(takeSignedOutNotice(), null, 'the notice shows once');
  });
  it('ignores a late answer about a token that is no longer the current one', async () => {
    globalThis.fetch = async () => {
      setToken('t2'); // signed in again while the request was on its way
      return { ok: false, status: 401, json: async () => ({ error: { message: 'No.', code: 'session_unknown' } }), headers: { get: () => null } };
    };
    await assert.rejects(api.listLessons());
    assert.equal(getToken(), 't2');
  });
  it('is not an end for a wrong password at sign-in', async () => {
    refuse(401, 'login_failed');
    await assert.rejects(api.login({ email: 'a@b.co', password: 'x' }), { code: 'login_failed' });
    assert.equal(getToken(), 't1');
  });
});
