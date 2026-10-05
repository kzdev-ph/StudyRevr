import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { truncateAtWord } from '../lib/format.js';

const EVIDENCE_MAX = 220;
const FLIP = { duration: 0.42, ease: [0.3, 0.7, 0.2, 1] };
const FADE = { duration: 0.16 };

function Front({ card, showLesson }) {
  return (
    <>
      <p className="flashcard__kicker">
        {card.kind === 'term' ? 'Term' : 'Question'}
        {showLesson && <span className="flashcard__lesson"> · {card.lesson_title}</span>}
      </p>
      <p className={`flashcard__front${card.kind === 'term' ? ' flashcard__front--term' : ''}`}>{card.front}</p>
    </>
  );
}

function Back({ card }) {
  return (
    <>
      <p className="flashcard__asked">{card.front}</p>
      <p className="flashcard__back">{card.back}</p>
      {card.evidence && (
        <p className="flashcard__evidence">
          <span className="flashcard__from">From the lesson:</span> “{truncateAtWord(card.evidence, EVIDENCE_MAX)}”
        </p>
      )}
    </>
  );
}

// The card. Tap anywhere on it to see the answer (the "Show answer" button below does the same for keyboards and
// screen readers). It turns over in 3D; with reduced motion the answer cross-fades in instead. The hidden side is
// inert, so it is never read out or focused.
export default function FlipCard({ card, revealed, onReveal, showLesson }) {
  const reduce = useReducedMotion();
  const reveal = () => {
    if (!revealed) onReveal();
  };

  if (reduce) {
    return (
      <div className={`flashcard flashcard--flat${revealed ? ' is-revealed' : ''}`} onClick={reveal}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={revealed ? 'back' : 'front'} className="flashcard__face" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={FADE}>
            {revealed ? <Back card={card} /> : <Front card={card} showLesson={showLesson} />}
          </motion.div>
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="flashcard-scene" onClick={reveal}>
      <motion.div className={`flashcard${revealed ? ' is-revealed' : ''}`} initial={false} animate={{ rotateY: revealed ? 180 : 0 }} transition={FLIP}>
        <div className="flashcard__face flashcard__face--front" aria-hidden={revealed} inert={revealed}>
          <Front card={card} showLesson={showLesson} />
        </div>
        <div className="flashcard__face flashcard__face--back" aria-hidden={!revealed} inert={!revealed}>
          <Back card={card} />
        </div>
      </motion.div>
    </div>
  );
}
