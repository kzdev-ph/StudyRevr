import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { riffleFrames, shufflePlan } from '../lib/paper.js';

const FADE_MS = 450;
const CARDS = 5;
const STAGGER_S = 0.03;

// The deck coming out as a flashcard deck starts: the cards split left and right and riffle back into one pile, 3 or
// 4 times (picked at random each time: 1.8 or 2.4 s). The order of the cards is already set by the scheduler
// (learning, due reviews, new), so it says "Getting your deck out", never "Shuffling". With reduced motion the deck
// just fades in and out. A tap, Enter, Space or Escape skips it. The first card's answer clock starts only once it is
// over, however long it ran. Calls `onDone` once.
export default function DeckShuffle({ onDone }) {
  const reduce = useReducedMotion();
  const [plan] = useState(() => shufflePlan());
  const done = useRef(false);
  const finish = useRef(onDone);
  finish.current = onDone;

  const end = () => {
    if (done.current) return;
    done.current = true;
    finish.current();
  };

  useEffect(() => {
    const timer = setTimeout(end, reduce ? FADE_MS : plan.ms);
    return () => clearTimeout(timer);
  }, [reduce, plan]);

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

  return (
    <div className="shuffle" onClick={end}>
      <div className="shuffle__deck" aria-hidden="true">
        {Array.from({ length: CARDS }, (_, i) => {
          const f = riffleFrames(i, CARDS, plan.riffles);
          const rest = { x: 0, y: f.y[0], rotate: f.rotate[0], zIndex: i };
          return reduce ? (
            <motion.div key={i} className="shuffle__card" style={rest} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} />
          ) : (
            <motion.div
              key={i}
              className="shuffle__card"
              initial={rest}
              animate={{ x: f.x, y: f.y, rotate: f.rotate, zIndex: f.zIndex }}
              transition={{ duration: (plan.ms - 150) / 1000, delay: i * STAGGER_S, times: f.times, ease: 'easeInOut' }}
            />
          );
        })}
      </div>
      <p className="shuffle__text" role="status">
        Getting your deck out
      </p>
      <p className="muted" aria-hidden="true">
        Tap or press Enter to skip
      </p>
    </div>
  );
}
