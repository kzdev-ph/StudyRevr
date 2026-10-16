import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAnswerClock } from '../src/lib/answerClock.js';
import { RIFFLE_MS, shufflePlan } from '../src/lib/paper.js';

// A fake clock: `at(ms)` moves time on.
function fake() {
  let t = 0;
  return { now: () => t, at: (ms) => (t = ms) };
}

// Today's animation lengths, with motion on and with reduced motion.
const FULL = { shuffle: shufflePlan(() => 0.9).ms, handout: 420, flip: 420 };
const REDUCED = { shuffle: 450, handout: 150, flip: 320 }; // fades, and the flip's cross-fade (out, then in)

describe('answer clock', () => {
  it('counts nothing while a question is coming in, then counts until the answer', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    const token = clock.show();
    t.at(420); // the sheet slid in
    assert.equal(clock.read(), 0);
    clock.usable(token);
    t.at(2420);
    assert.equal(clock.stop(), 2000);
    assert.equal(clock.state, 'stopped');
  });

  it('a tap or key during the entrance starts the clock (the student is already using it)', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    const token = clock.show();
    t.at(100);
    clock.input();
    t.at(900);
    clock.usable(token); // the entrance ends later: changes nothing
    assert.equal(clock.stop(), 800);
  });

  it('leaves the flashcard turning over out of the time', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    clock.usable(clock.show());
    t.at(3000); // reading the front
    clock.input();
    clock.pause(); // Show answer: the card turns over
    t.at(3420);
    clock.resume();
    t.at(4420); // reading the answer
    assert.equal(clock.stop(), 4000);
  });

  it('an answer given while the card is still turning counts only the time before the turn', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    clock.usable(clock.show());
    t.at(1500);
    clock.pause();
    t.at(1700);
    assert.equal(clock.stop(), 1500);
    t.at(1920);
    clock.resume(); // the flip ends after the answer: ignored
    assert.equal(clock.read(), 1500);
  });

  it('a late "usable" from an earlier question never starts the next one', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    const first = clock.show();
    t.at(50);
    clock.input();
    t.at(1200);
    clock.stop();
    const second = clock.show(); // Next
    t.at(1210);
    assert.equal(clock.usable(first), false); // the first question's paint arrives late
    assert.equal(clock.state, 'waiting');
    t.at(1230);
    assert.equal(clock.usable(second), true);
    t.at(2230);
    assert.equal(clock.stop(), 1000);
  });

  it('answer marks after an answer never move the next clock', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    clock.usable(clock.show());
    t.at(2000);
    clock.stop(); // saved; the pen loop and tick play now (440 ms)
    t.at(2100); // Next pressed half-way through the marks
    const next = clock.show();
    t.at(2133); // painted
    clock.usable(next);
    t.at(3133);
    assert.equal(clock.stop(), 1000);
  });

  it('gives the same time_ms with motion on and with reduced motion', () => {
    // the same student: the same time looking at each card and question, whatever the animations take
    const sitting = (m) => {
      const t = fake();
      const clock = createAnswerClock(t.now);
      const times = [];
      let now = 0;
      // flashcards: the deck comes out, the first card is usable when it ends
      let token = clock.show();
      now += m.shuffle;
      t.at(now);
      clock.usable(token);
      now += 2500; // reads the front
      t.at(now);
      clock.pause(); // Show answer
      now += m.flip;
      t.at(now);
      clock.resume();
      now += 1200; // reads the answer, then Good
      t.at(now);
      times.push(clock.stop());
      // the next card is on top from the first frame
      token = clock.show();
      now += 16;
      t.at(now);
      clock.usable(token);
      now += 3100;
      t.at(now);
      clock.pause();
      now += m.flip;
      t.at(now);
      clock.resume();
      now += 900;
      t.at(now);
      times.push(clock.stop());
      // a quiz: the sheet is handed out, then two questions
      token = clock.show();
      now += m.handout;
      t.at(now);
      clock.usable(token);
      now += 6400;
      t.at(now);
      times.push(clock.stop());
      token = clock.show();
      now += 16;
      t.at(now);
      clock.usable(token);
      now += 5200;
      t.at(now);
      times.push(clock.stop());
      return times;
    };
    assert.deepEqual(sitting(FULL), [3700, 4000, 6400, 5200]);
    assert.deepEqual(sitting(REDUCED), sitting(FULL));
  });

  it('the whole deck shuffle is left out, however many riffles it has', () => {
    for (const r of [0.1, 0.9]) {
      const t = fake();
      const clock = createAnswerClock(t.now);
      const token = clock.show();
      const { ms } = shufflePlan(() => r);
      t.at(ms);
      clock.usable(token);
      t.at(ms + 1800);
      assert.equal(clock.stop(), 1800);
    }
  });

  it('an answer that was not saved carries on from the time counted', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    clock.usable(clock.show());
    t.at(1000);
    assert.equal(clock.stop(), 1000);
    t.at(1400); // the request failed; the student chooses again
    clock.reopen();
    t.at(2000);
    assert.equal(clock.stop(), 1600);
  });

  it('stays at 0 until something starts it, and never runs backwards', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    assert.equal(clock.state, 'idle');
    clock.show();
    t.at(5000);
    assert.equal(clock.read(), 0);
    clock.pause();
    clock.resume();
    assert.equal(clock.state, 'waiting');
    assert.equal(clock.stop(), 0);
  });
});

describe('answer clock and a hidden app', () => {
  it('pauses while the app is hidden and carries on when it is back', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    clock.usable(clock.show());
    t.at(2000);
    clock.pause('hidden'); // the phone locks
    t.at(602000); // ten minutes later
    clock.resume('hidden');
    t.at(603000);
    assert.equal(clock.stop(), 3000);
  });

  it('a card that finishes turning while the app is hidden does not start the clock', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    clock.usable(clock.show());
    t.at(1000);
    clock.pause('flip');
    t.at(1100);
    clock.pause('hidden');
    t.at(1500);
    clock.resume('flip'); // the turn ends in the background
    assert.equal(clock.state, 'paused');
    t.at(60000);
    clock.resume('hidden');
    t.at(60800);
    assert.equal(clock.stop(), 1800); // 1000 before the turn + 800 after coming back
  });

  it('coming back during a turn does not end the turn pause', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    clock.usable(clock.show());
    t.at(1000);
    clock.pause('flip');
    clock.pause('hidden');
    t.at(5000);
    clock.resume('hidden'); // visible again, the turn is still going
    assert.equal(clock.state, 'paused');
    t.at(5300);
    clock.resume('flip');
    t.at(6300);
    assert.equal(clock.stop(), 2000);
  });

  it('an entrance that ends while the app is hidden starts counting only when it is back', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    const token = clock.show();
    clock.pause('hidden');
    t.at(500);
    clock.usable(token);
    assert.equal(clock.state, 'paused');
    t.at(10500);
    clock.resume('hidden');
    t.at(11500);
    assert.equal(clock.stop(), 1000);
  });

  it('a hidden app stays hidden for the next card, a finished turn does not carry over', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    clock.usable(clock.show());
    clock.pause('flip');
    clock.stop();
    const next = clock.show(); // the old card's turn is over with it
    clock.usable(next);
    t.at(1000);
    assert.equal(clock.state, 'running');
    clock.pause('hidden');
    clock.stop();
    clock.show();
    assert.equal(clock.state, 'waiting');
  });

  it('a failed save while hidden reopens paused', () => {
    const t = fake();
    const clock = createAnswerClock(t.now);
    clock.usable(clock.show());
    t.at(1000);
    clock.stop();
    clock.pause('hidden');
    clock.reopen();
    assert.equal(clock.state, 'paused');
    clock.resume('hidden');
    t.at(2000);
    assert.equal(clock.stop(), 2000);
  });
});

describe('deck shuffle plan', () => {
  it('3 or 4 riffles of about 600 ms, 1.8 to 2.4 s in all', () => {
    assert.deepEqual(shufflePlan(() => 0.2), { riffles: 3, ms: 3 * RIFFLE_MS });
    assert.deepEqual(shufflePlan(() => 0.7), { riffles: 4, ms: 4 * RIFFLE_MS });
    for (let k = 0; k < 50; k += 1) {
      const { riffles, ms } = shufflePlan();
      assert.ok(riffles === 3 || riffles === 4);
      assert.ok(ms >= 1800 && ms <= 2400);
    }
  });
});
