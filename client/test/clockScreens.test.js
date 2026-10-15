import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The real flashcard and quiz screens, in jsdom with a fake clock (test/helpers/), driven by real clicks and keys:
// the time_ms the app sends to the server with motion on and with prefers-reduced-motion. Reduced motion is read once
// when motion loads, so each run is its own process. See helpers/scenario.mjs for what the student does.
const clientDir = fileURLToPath(new URL('..', import.meta.url));

function run({ reduced, mode }) {
  const result = spawnSync(process.execPath, ['--import', './test/helpers/register.mjs', 'test/helpers/scenario.mjs'], {
    cwd: clientDir,
    env: { ...process.env, REDUCED: reduced ? '1' : '0', MODE: mode },
    encoding: 'utf8',
    timeout: 110_000,
  });
  const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${result.status}):\n${result.stderr}`);
  return JSON.parse(line.slice('RESULT '.length));
}

const FRAME = 16; // the app starts a clock two animation frames after a card is on screen
const within = (value, expected) => assert.ok(value <= expected && value >= expected - 2 * FRAME - 2, `${value} should be ${expected - 2 * FRAME - 2}..${expected}`);

describe('time_ms from the real screens', { concurrency: true }, () => {
  const runs = {};
  for (const mode of ['natural', 'skip']) {
    for (const reduced of [false, true]) runs[`${mode}-${reduced}`] = run({ reduced, mode });
  }

  for (const [name, r] of Object.entries(runs)) {
    it(`${name}: counts only the time the student spent (no animation, no time away)`, () => {
      // card 1: 2.5 s on the front + 1.2 s on the answer; card 2: 1 s + 2.1 s + 0.9 s, with the app hidden for a minute
      within(r.cards[0], 3700);
      within(r.cards[1], 4000);
      // question 1: 6.4 s after the hand-out; question 2: 5.2 s
      assert.ok(Math.abs(r.answers[0] - 6400) <= 2 * FRAME, `${r.answers[0]}`);
      within(r.answers[1], 5200);
    });

    it(`${name}: a card cannot be rated while it is still turning`, () => {
      assert.equal(r.readyMidTurn, false);
      assert.equal(r.ratedMidTurn, 0);
    });
  }

  it('reduced motion gives the same time_ms as full motion when the student taps through the animations', () => {
    assert.deepEqual(runs['skip-true'].cards, runs['skip-false'].cards);
    assert.deepEqual(runs['skip-true'].answers, runs['skip-false'].answers);
  });

  it('reduced motion gives the same time_ms to within one frame when the animations run to their end', () => {
    const full = runs['natural-false'];
    const reduced = runs['natural-true'];
    for (const k of [0, 1]) {
      assert.ok(Math.abs(full.cards[k] - reduced.cards[k]) <= FRAME, `card ${k}: ${full.cards[k]} vs ${reduced.cards[k]}`);
      assert.ok(Math.abs(full.answers[k] - reduced.answers[k]) <= FRAME, `question ${k}: ${full.answers[k]} vs ${reduced.answers[k]}`);
    }
  });
});
