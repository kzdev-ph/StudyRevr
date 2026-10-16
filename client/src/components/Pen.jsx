import { useLayoutEffect, useRef } from 'react';
import { animate } from 'motion/react';
import { useMotionReduced } from '../lib/motion.js';
import { loopPath } from '../lib/paper.js';

const OUT = [0.16, 1, 0.3, 1];
const FADE_S = 0.15;

// One pen stroke, drawn in once when it appears (stroke-dashoffset, nothing else moves); with reduced motion it fades
// in. `track` (a Set) collects the running animation so a tap can finish it.
export function Stroke({ d, duration, delay = 0, track }) {
  const ref = useRef(null);
  const reduce = useMotionReduced();
  useLayoutEffect(() => {
    const controls = reduce
      ? animate(ref.current, { opacity: [0, 1] }, { duration: FADE_S })
      : animate(ref.current, { strokeDashoffset: [1, 0] }, { duration: duration / 1000, delay: delay / 1000, ease: OUT });
    track?.add(controls);
    return () => {
      track?.delete(controls);
      controls.stop();
    };
  }, [d, duration, delay, reduce, track]);
  return <path ref={ref} d={d} pathLength="1" style={{ strokeDasharray: 1, strokeDashoffset: reduce ? 0 : 1 }} />;
}

// A hand-drawn loop round a w x h box.
export function PenLoop({ w, h, className, duration, delay, track, shape }) {
  return (
    <svg className={className} viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
      <Stroke d={loopPath(w, h, shape)} duration={duration} delay={delay} track={track} />
    </svg>
  );
}

// A line struck through a wrong answer (one line of text), drawn from the left (scaleX).
export function PenStrike({ duration, delay = 0, track }) {
  const ref = useRef(null);
  const reduce = useMotionReduced();
  useLayoutEffect(() => {
    const controls = reduce
      ? animate(ref.current, { opacity: [0, 1] }, { duration: FADE_S })
      : animate(ref.current, { scaleX: [0, 1] }, { duration: duration / 1000, delay: delay / 1000, ease: OUT });
    track?.add(controls);
    return () => {
      track?.delete(controls);
      controls.stop();
    };
  }, [duration, delay, reduce, track]);
  return <span ref={ref} className="pen-strike" aria-hidden="true" style={reduce ? undefined : { transform: 'scaleX(0)' }} />;
}

// The teacher's tick, in a 20 x 20 box.
export function PenTick({ className, duration, delay, track }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <Stroke d="M3.5 10.5 L8.5 15.5 L17 4" duration={duration} delay={delay} track={track} />
    </svg>
  );
}
