import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';

const SHUFFLE_MS = 1200;
const FADE_MS = 450;
const CARDS = 5;

// The deck being shuffled as a quiz starts: the cards split left and right and riffle back into one pile, twice.
// The server has already set the question order; this is the moment it happens on screen. With reduced motion the
// deck just fades in and out. Tapping it skips ahead. Calls `onDone` once.
export default function DeckShuffle({ count, onDone }) {
  const reduce = useReducedMotion();
  const done = useRef(false);
  const finish = useRef(onDone);
  finish.current = onDone;

  const end = () => {
    if (done.current) return;
    done.current = true;
    finish.current();
  };

  useEffect(() => {
    const timer = setTimeout(end, reduce ? FADE_MS : SHUFFLE_MS);
    return () => clearTimeout(timer);
  }, [reduce]);

  // Enter, Space or Escape skip it too, so it is not a touch-only shortcut
  useEffect(() => {
    const onKey = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
        event.preventDefault();
        end();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shown = Math.max(1, Math.min(CARDS, count));
  return (
    <div className="shuffle" onClick={end}>
      <div className="shuffle__deck" aria-hidden="true">
        {Array.from({ length: shown }, (_, i) => {
          const side = i % 2 ? 1 : -1;
          const rest = { x: 0, y: -i * 3, rotate: (i - (shown - 1) / 2) * 1.5 };
          return reduce ? (
            <motion.div key={i} className="shuffle__card" style={rest} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} />
          ) : (
            <motion.div
              key={i}
              className="shuffle__card"
              initial={rest}
              animate={{
                x: [0, side * 78, 0, side * -54, 0],
                y: [rest.y, rest.y - 10, rest.y, rest.y - 6, rest.y],
                rotate: [rest.rotate, side * 9, rest.rotate, side * -6, rest.rotate],
                zIndex: [i, i, shown - i, shown - i, i],
              }}
              transition={{ duration: (SHUFFLE_MS - 150) / 1000, delay: i * 0.03, times: [0, 0.25, 0.5, 0.75, 1], ease: 'easeInOut' }}
            >
              {i === shown - 1 && <span className="shuffle__mark">?</span>}
            </motion.div>
          );
        })}
      </div>
      <p className="shuffle__text" role="status">
        Shuffling {count} {count === 1 ? 'question' : 'questions'}…
      </p>
      <p className="muted" aria-hidden="true">
        Tap or press Enter to skip
      </p>
    </div>
  );
}
