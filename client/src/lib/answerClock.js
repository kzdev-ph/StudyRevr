// The research clock for one quiz question or one flashcard: its time_ms. Pure (the time source is passed in), so it
// is tested with a fake clock in client/test.
//
// The rule: the clock starts when the question or card is on screen and usable (its entrance has finished or was
// skipped, the first frame showing it was painted, or the student's first tap or key, whichever comes first), pauses
// while a flashcard turns over, and stops at the answer. Animation is never counted, with motion on or reduced, so a
// student's motion setting never changes their numbers. Marks that play after an answer belong to the old question
// and never touch the next clock.
//
//   idle -> show() -> waiting -> usable(token) | input() -> running <-> paused (pause / resume) -> stop() -> stopped
export function createAnswerClock(now) {
  let state = 'idle';
  let token = 0;
  let acc = 0; // ms counted before the current run
  let since = 0; // when the current run began

  const run = () => {
    state = 'running';
    since = now();
  };
  const read = () => Math.max(0, Math.round(acc + (state === 'running' ? now() - since : 0)));

  return {
    get state() {
      return state;
    },
    // A new question or card is going on screen. Returns its token: a late "usable" signal for an earlier one (the
    // last frame of a question already answered, a paint scheduled before Next) is ignored.
    show() {
      token += 1;
      acc = 0;
      state = 'waiting';
      return token;
    },
    // Its entrance is over: start counting, once, and only for the current one.
    usable(t) {
      if (t !== token || state !== 'waiting') return false;
      run();
      return true;
    },
    // A tap or key before the entrance ended: the student is already using it.
    input() {
      if (state === 'waiting') run();
    },
    pause() {
      if (state !== 'running') return;
      acc += now() - since;
      state = 'paused';
    },
    resume() {
      if (state === 'paused') run();
    },
    read,
    // The answer wasn't saved (a network error) and the question is still open: carry on from the time counted.
    reopen() {
      if (state === 'stopped') run();
    },
    // The answer: the time counted, and the clock stays stopped until the next show().
    stop() {
      const ms = read();
      acc = ms;
      state = 'stopped';
      return ms;
    },
  };
}
