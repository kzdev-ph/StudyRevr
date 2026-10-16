import { useEffect, useState } from 'react';
import { CardsIcon, QuizIcon } from './Icons.jsx';
import { api } from '../lib/api.js';
import { studyMinutes, totalDue } from '../lib/flashcards.js';
import { paths } from '../lib/router.js';

// "Study N due flashcards (~X min)", from the lesson's deck. null while loading or if it can't be read.
function useDeckSummary(lessonId) {
  const [deck, setDeck] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    api.getDue(lessonId, controller.signal).then(setDeck, () => {});
    return () => controller.abort();
  }, [lessonId]);
  return deck;
}

function flashcardLine(deck) {
  if (!deck) return 'Flip, rate and remember the lesson’s cards.';
  if (!deck.total) return 'This lesson has no cards yet. Your teacher can make them.';
  const n = totalDue(deck.counts);
  if (!n) return 'All caught up for today.';
  return `${n} ${n === 1 ? 'card' : 'cards'} to study, about ${studyMinutes(deck.counts)} min.`;
}

// What to do after the last section: study the lesson's flashcards, or take its mock quiz.
export default function EndCard({ lessonId, sectionCount, termCount, onRestart }) {
  const deck = useDeckSummary(lessonId);
  return (
    <section className="endcard" aria-labelledby="whats-next">
      <h2 id="whats-next" className="endcard__title">
        What’s next
      </h2>
      <p className="endcard__lede">
        You’ve read all {sectionCount} {sectionCount === 1 ? 'section' : 'sections'}. Now make it stick.
      </p>
      <div className="endcard__actions">
        <a className="endcard__action" href={deck?.total ? paths.study(lessonId) : paths.tab('flashcards')}>
          <CardsIcon size={26} />
          <span>
            <strong>Study flashcards</strong>
            <small>{flashcardLine(deck)}</small>
          </span>
        </a>
        <a className="endcard__action" href={deck?.total ? paths.quiz(lessonId) : paths.tab('quiz')}>
          <QuizIcon size={26} />
          <span>
            <strong>Take a mock quiz</strong>
            <small>Test yourself on the whole lesson.</small>
          </span>
        </a>
      </div>
      <div className="endcard__more">
        {termCount > 0 && (
          <a className="link-btn" href={paths.lesson(lessonId, 'terms')}>
            Go over the key terms
          </a>
        )}
        <button type="button" className="link-btn" onClick={onRestart}>
          Read the sections again
        </button>
      </div>
    </section>
  );
}
