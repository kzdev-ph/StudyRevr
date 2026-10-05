import { CardsIcon, QuizIcon } from './Icons.jsx';
import { paths } from '../lib/router.js';

// What to do after the last section. Flashcards and quizzes are placeholders until those screens exist.
export default function EndCard({ lessonId, sectionCount, termCount, onBack, onRestart }) {
  return (
    <section className="endcard" aria-labelledby="whats-next">
      <h2 id="whats-next" className="endcard__title">
        What’s next
      </h2>
      <p className="endcard__lede">
        {sectionCount === 1 ? 'You finished the section.' : `You finished all ${sectionCount} sections.`} Next, practice what you read.
      </p>
      <div className="endcard__actions">
        <a className="endcard__action" href={paths.tab('flashcards')}>
          <CardsIcon size={26} />
          <span>
            <strong>Study flashcards</strong>
            <small>Flip and rate cards from this lesson.</small>
          </span>
        </a>
        <a className="endcard__action" href={paths.tab('quiz')}>
          <QuizIcon size={26} />
          <span>
            <strong>Take a mock quiz</strong>
            <small>Answer multiple-choice questions on the whole lesson.</small>
          </span>
        </a>
      </div>
      <div className="endcard__more">
        {termCount > 0 && (
          <a className="link-btn" href={paths.lesson(lessonId, 'terms')}>
            Go over the key terms
          </a>
        )}
        <button type="button" className="link-btn" onClick={onBack}>
          Back to the last section
        </button>
        <button type="button" className="link-btn" onClick={onRestart}>
          Read the sections again
        </button>
      </div>
    </section>
  );
}
