import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { createAnswerClock } from '../lib/answerClock.js';

// The answer clock (lib/answerClock.js) for a screen. `showAtPaint()` puts a new question or card on screen with no
// entrance: it becomes usable once the frame that shows it has been painted (two animation frames after React has put
// it in the page). A hidden tab paints nothing, so the clock waits until the student can see it or touches it.
// `show()` is for an entrance: call `clock.usable(token)` when it ends or is skipped.
// While the app is hidden (a locked phone, another app or tab) the clock is paused, so time away is never counted.
export function useAnswerClock() {
  const ref = useRef(null);
  if (!ref.current) ref.current = createAnswerClock(() => performance.now());
  const clock = ref.current;
  const pending = useRef(null); // the token waiting for its first paint

  useEffect(() => {
    const sync = () => (document.visibilityState === 'hidden' ? clock.pause('hidden') : clock.resume('hidden'));
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [clock]);

  // After every render: the content is in the page; count from the frame after it is painted. A render in between
  // starts the wait again (the screen changed), and leaving the screen cancels it. (This runs on every render of the
  // screen by design: a screen that re-rendered on every frame would never get past the wait, and none does.)
  useLayoutEffect(() => {
    const token = pending.current;
    if (token === null) return undefined;
    let id = requestAnimationFrame(() => {
      id = requestAnimationFrame(() => {
        if (pending.current === token) pending.current = null;
        clock.usable(token);
      });
    });
    return () => cancelAnimationFrame(id);
  });

  const showAtPaint = useCallback(() => {
    pending.current = clock.show();
    return pending.current;
  }, [clock]);
  const show = useCallback(() => {
    pending.current = null;
    return clock.show();
  }, [clock]);

  return { clock, show, showAtPaint };
}
