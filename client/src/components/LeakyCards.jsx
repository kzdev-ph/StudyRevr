import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// Plain words for the leak rules a flashcard can break (server/src/quiz/leaks.js). Rule h is not listed: the quiz
// blanks the term, so the server doesn't flag it.
const RULE_TEXT = {
  g: 'the question holds the answer',
  i: 'a yes/no or either/or question',
  j: 'the question holds another card’s answer',
  k: 'the answer only repeats the question',
};

// Why the cards can't be regenerated now (regenerate_blocked from the leaks report).
const BLOCKED_TEXT = {
  lesson_has_records: 'Participants have studied this lesson, so its cards can’t change now.',
  lesson_busy: 'This lesson is being worked on. Regenerate its cards once that finishes.',
};

// Admin only: the lesson's flashcards that give their answer away (GET /api/admin/lessons/:id/leaks), each with
// "Regenerate this card" while no participant other than P00 has studied the lesson and no job runs on it.
// `onChanged` reloads the list.
export default function LeakyCards({ lesson, onChanged }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(null);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  // after a regenerate: the place in the list whose button gets focus once the new report is shown
  const [focusAt, setFocusAt] = useState(null);
  const toggleRef = useRef(null);
  const buttons = useRef(new Map());
  const listId = useId();
  const count = report ? report.cards.flagged.length : lesson.leaks?.cards ?? 0;

  useEffect(() => {
    if (focusAt === null || !report || busy !== null) return; // the buttons are disabled while a card is written
    const flagged = report.cards.flagged;
    const next = report.can_regenerate && flagged.length ? flagged[Math.min(focusAt, flagged.length - 1)] : null;
    (next ? buttons.current.get(next.id) : toggleRef.current)?.focus();
    setFocusAt(null);
  }, [focusAt, report, busy]);

  // the toggle stays while the list is open, so focus has somewhere to go after the last card is fixed
  if (lesson.status !== 'ready' || (!count && !open && !done && !error)) return null;

  const load = async () => {
    try {
      const next = await api.lessonLeaks(lesson.id);
      setReport(next);
      return next;
    } catch (err) {
      setError(err.message);
      return null;
    }
  };
  const toggle = async () => {
    setError('');
    if (open) return setOpen(false);
    if (!report && !(await load())) return; // loading failed: the error says why, and the list stays closed
    setOpen(true);
  };
  const regenerate = async (id) => {
    const at = report.cards.flagged.findIndex((c) => c.id === id);
    setBusy(id);
    setDone('');
    setError('');
    try {
      await api.regenerateCard(id);
      setDone('Card written again. Its quiz answers are made with “Make quiz answers”.');
      await load();
      setFocusAt(at);
      await onChanged?.();
    } catch (err) {
      setError(err.message);
      setFocusAt(at); // its button was disabled while writing: give focus back to it
    }
    setBusy(null);
  };

  const blocked = report && !report.can_regenerate ? BLOCKED_TEXT[report.regenerate_blocked] ?? BLOCKED_TEXT.lesson_has_records : null;
  return (
    <div className="lesson__extra">
      {count > 0 && (
        <p className="lesson__extra-text">
          <span>
            <strong>
              {count} {count === 1 ? 'flashcard gives' : 'flashcards give'} the answer away.
            </strong>{' '}
            Students could answer {count === 1 ? 'it' : 'them'} without studying.
          </span>
        </p>
      )}
      {(count > 0 || open) && (
        <button type="button" className="btn btn--quiet" aria-expanded={open} aria-controls={listId} onClick={toggle} ref={toggleRef}>
          {open ? 'Hide cards' : 'Show cards'}
        </button>
      )}
      <p className="status-ok" role="status">
        {busy !== null ? 'Writing the card…' : done}
      </p>
      {error && (
        <p className="lesson__extra-text lesson__leak-error" role="alert">
          {error}
        </p>
      )}
      <ul id={listId} className="lesson__leaks" hidden={!open || !report} aria-busy={busy !== null}>
        {report?.cards.flagged.map((card) => (
          <li key={card.id} className="lesson__extra">
            <div className="lesson__leak-card">
              <p>
                <span className="visually-hidden">Question: </span>
                <strong>{card.front}</strong>
              </p>
              <p>
                <span className="visually-hidden">Answer: </span>
                {card.back}
              </p>
              <p>
                <span className="visually-hidden">Why it gives the answer away: </span>
                {[...new Set(card.rules.map((r) => RULE_TEXT[r.rule] ?? r.rule))].join('; ')}
              </p>
            </div>
            {report.can_regenerate && (
              <button
                type="button"
                className="btn btn--quiet"
                aria-label={`Regenerate this card: ${card.front}`}
                onClick={() => regenerate(card.id)}
                disabled={busy !== null}
                ref={(el) => (el ? buttons.current.set(card.id, el) : buttons.current.delete(card.id))}
              >
                {busy === card.id ? 'Writing…' : 'Regenerate this card'}
              </button>
            )}
          </li>
        ))}
        {report && !report.cards.flagged.length && (
          <li className="lesson__extra">
            <p className="lesson__extra-text">No flashcard gives its answer away now.</p>
          </li>
        )}
        {blocked && report.cards.flagged.length > 0 && (
          <li className="lesson__extra">
            <p className="lesson__extra-text">{blocked}</p>
          </li>
        )}
      </ul>
    </div>
  );
}
