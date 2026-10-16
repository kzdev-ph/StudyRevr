import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAdminPin, lockAdmin, setAdminPin } from '../src/lib/admin.js';
import { api } from '../src/lib/api.js';
import { getParticipant, setParticipant, switchParticipant } from '../src/lib/participant.js';

// The admin PIN is sent only by calls made for admin. A student on a tab where admin was unlocked must still be just a
// student: no private uploads of others, no owner codes, no teacher uploads. Every `api` function is listed here, so a
// new one has to be classified (the last test fails until it is).

// always admin: they send the PIN
const ADMIN = [
  'listLessonsWithCounts', 'shareLesson', 'makeQuizOptions', 'lessonLeaks', 'regenerateCard', 'prepareVersions', 'makeFlashcards',
  'adminParticipants', 'addParticipants', 'adminStats', 'appSettings', 'saveAppSettings', 'aiSettings', 'saveAiSettings', 'aiModels',
  'testAi', 'aiProblems', 'deleteStudentKeys', 'downloadBackup', 'lastBackup', 'downloadExport',
];
// admin only when called with { admin: true } (the student's own use of the same route sends none)
const EITHER = ['getLesson', 'uploadLesson', 'retryLesson', 'deleteLesson'];
// student calls: never the PIN
const STUDENT = [
  'listLessons', 'getStatus', 'myUploads', 'simplifySection', 'translateSection', 'saveProgress', 'listDecks', 'getDue', 'answerCard',
  'undoAnswer', 'listQuizzes', 'startQuiz', 'answerQuestion', 'finishQuiz', 'checkParticipant', 'startSession', 'reportSession', 'logEvent',
  'logSettingEvent', 'getStats', 'myAi', 'myAiModels', 'saveMyKey', 'removeMyKey',
];
// sends the PIN it is given (to check it), not the stored one
const OWN_PIN = ['unlockAdmin'];

const realFetch = globalThis.fetch;
let seen;

beforeEach(() => {
  seen = [];
  setParticipant('P01');
  setAdminPin('1234');
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers ?? {} });
    return { ok: true, status: 200, json: async () => ({}), headers: { get: () => null }, blob: async () => ({}) };
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  lockAdmin();
  setParticipant(null);
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
      assert.equal(headers['x-participant'], 'P01', `${name} still says who is studying`);
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
  it('is not stored with the student: a student request after unlocking carries none', async () => {
    assert.equal(getAdminPin(), '1234');
    const headers = await call('listLessons');
    assert.equal(headers['x-admin-pin'], undefined);
    assert.equal(headers['x-participant'], 'P01');
  });
  it('classifies every api function', () => {
    const listed = [...ADMIN, ...EITHER, ...STUDENT, ...OWN_PIN].sort();
    assert.deepEqual(Object.keys(api).sort(), listed);
    assert.equal(new Set(listed).size, listed.length, 'a function is in two lists');
  });
});

describe('Switch participant', () => {
  it('locks admin again and forgets the code', () => {
    assert.equal(getAdminPin(), '1234');
    switchParticipant();
    assert.equal(getAdminPin(), null);
    assert.equal(getParticipant(), null);
  });
  it('leaves a later student request without the PIN', async () => {
    switchParticipant();
    setParticipant('P02');
    const headers = await call('listLessons');
    assert.equal(headers['x-admin-pin'], undefined);
    assert.equal(headers['x-participant'], 'P02');
  });
});
