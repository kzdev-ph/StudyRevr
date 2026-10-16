import { AnimatePresence, motion } from 'motion/react';
import { useMotionReduced } from '../lib/motion.js';
import { truncateAtWord } from '../lib/format.js';

const EVIDENCE_MAX = 220;
const FLIP = { duration: 0.42, ease: [0.3, 0.7, 0.2, 1] };
const FADE = { duration: 0.16 };
const FOLD = 0.16; // the fold shadow at its darkest, when the card stands on its edge

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
// screen readers). It turns over like paper: rotated in 3D, lifted 4 px at the halfway point, with a fold shadow that
// is darkest when it stands on its edge. With reduced motion the answer cross-fades in instead. The hidden side is
// inert, so it is never read out or focused. `onTurned` is called when the answer side is fully shown (the answer
// clock is paused until then). Mount one per card (key it by the card), so a new card never turns back.
export default function FlipCard({ card, revealed, onReveal, onTurned, showLesson }) {
  const reduce = useMotionReduced();
  const reveal = () => {
    if (!revealed) onReveal();
  };

  if (reduce) {
    return (
      <div className={`flashcard flashcard--flat${revealed ? ' is-revealed' : ''}`} onClick={reveal}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={revealed ? 'back' : 'front'}
            className="flashcard__face"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={FADE}
            onAnimationComplete={revealed ? onTurned : undefined}
          >
            {revealed ? <Back card={card} /> : <Front card={card} showLesson={showLesson} />}
          </motion.div>
        </AnimatePresence>
      </div>
    );
  }

  const shade = { ...FLIP, times: [0, 0.5, 1] };
  return (
    <div className="flashcard-scene" onClick={reveal}>
      <motion.div
        className={`flashcard${revealed ? ' is-revealed' : ''}`}
        initial={false}
        animate={revealed ? { rotateY: 180, y: [0, -4, 0] } : { rotateY: 0, y: 0 }}
        transition={FLIP}
        onAnimationComplete={() => revealed && onTurned?.()}
      >
        <div className="flashcard__face flashcard__face--front" aria-hidden={revealed} inert={revealed}>
          <Front card={card} showLesson={showLesson} />
          <motion.span className="flashcard__shade" aria-hidden="true" initial={false} animate={{ opacity: revealed ? [0, FOLD, FOLD] : 0 }} transition={shade} />
        </div>
        <div className="flashcard__face flashcard__face--back" aria-hidden={!revealed} inert={!revealed}>
          <Back card={card} />
          <motion.span className="flashcard__shade flashcard__shade--back" aria-hidden="true" initial={false} animate={{ opacity: revealed ? [FOLD, FOLD, 0] : 0 }} transition={shade} />
        </div>
      </motion.div>
    </div>
  );
}
