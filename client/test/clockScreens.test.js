import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The real flashcard and quiz screens, in jsdom with a fake clock (test/helpers/), driven by real clicks and keys:
// the time_ms the app sends to the server with motion on and with prefers-reduced-motion. Reduced motion is read once
// when motion loads, so each run is its own process. See helpers/scenario.mjs for what the student does.
const clientDir = fileURLToPath(new URL('..', import.meta.url));

function run({ reduced, mode, motion }) {
  const result = spawnSync(process.execPath, ['--import', './test/helpers/register.mjs', 'test/helpers/scenario.mjs'], {
    cwd: clientDir,
    env: { ...process.env, REDUCED: reduced ? '1' : '0', MODE: mode, MOTION: motion },
    encoding: 'utf8',
    timeout: 110_000,
  });
  const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${result.status}):\n${result.stderr}`);
  return JSON.parse(line.slice('RESULT '.length));
}

const FRAME = 16; // the app starts a clock two animation frames after a card is on screen
const within = (value, expected) => assert.ok(value <= expected && value >= expected - 2 * FRAME - 2, `${value} should be ${expected - 2 * FRAME - 2}..${expected}`);

// The Motion setting (Match my device / Less motion / Full motion) is visual only: with every choice, on a device that asks
// for less motion or not, the same student gets the same time_ms. Reduced is what the helper resolves to.
describe('time_ms from the real screens', { concurrency: true }, () => {
  const runs = {};
  for (const mode of ['natural', 'skip']) {
    for (const reduced of [false, true]) {
      for (const motion of ['system', 'less', 'full']) runs[`${mode}-device${reduced ? 'Reduces' : 'Full'}-${motion}`] = run({ reduced, mode, motion });
    }
  }
  const effective = (r) => (r.effectiveReduced ? 'reduced' : 'full');

  for (const [name, r] of Object.entries(runs)) {
    it(`${name}: the setting resolves to what the helper says`, () => {
      assert.equal(r.effectiveReduced, r.motion === 'less' ? true : r.motion === 'full' ? false : r.reduced);
    });

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

  it('every Motion choice and device setting gives the same time_ms when the student taps through the animations', () => {
    const skip = Object.entries(runs).filter(([name]) => name.startsWith('skip-')).map(([, r]) => r);
    assert.equal(skip.length, 6);
    assert.deepEqual(new Set(skip.map(effective)), new Set(['reduced', 'full'])); // both kinds were really run
    for (const r of skip) {
      assert.deepEqual(r.cards, skip[0].cards);
      assert.deepEqual(r.answers, skip[0].answers);
    }
  });

  it('every Motion choice and device setting gives the same time_ms to within one frame when the animations run to their end', () => {
    const natural = Object.entries(runs).filter(([name]) => name.startsWith('natural-')).map(([, r]) => r);
    assert.equal(natural.length, 6);
    assert.deepEqual(new Set(natural.map(effective)), new Set(['reduced', 'full']));
    for (const r of natural) {
      for (const k of [0, 1]) {
        assert.ok(Math.abs(r.cards[k] - natural[0].cards[k]) <= FRAME, `card ${k}: ${r.cards[k]} vs ${natural[0].cards[k]}`);
        assert.ok(Math.abs(r.answers[k] - natural[0].answers[k]) <= FRAME, `question ${k}: ${r.answers[k]} vs ${natural[0].answers[k]}`);
      }
    }
  });
});
