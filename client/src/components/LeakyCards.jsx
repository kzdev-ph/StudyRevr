import { useState } from 'react';
import { api } from '../lib/api.js';

// Plain words for the leak rules a flashcard can break (server/src/quiz/leaks.js).
const RULE_TEXT = {
  g: 'the question holds the answer',
  h: 'the definition names the term',
  i: 'a yes/no or either/or question',
  j: 'the question holds another card’s answer',
  k: 'the answer only repeats the question',
};

// Admin only: the lesson's flashcards that give their answer away (GET /api/admin/lessons/:id/leaks), each with
// "Regenerate this card" while no participant other than P00 has studied the lesson. `onChanged` reloads the list.
export default function LeakyCards({ lesson, onChanged }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const count = report ? report.cards.flagged.length : lesson.leaks?.cards ?? 0;
  if (lesson.status !== 'ready' || (!count && !message)) return null;

  const load = async () => {
    try {
      setReport(await api.lessonLeaks(lesson.id));
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    }
  };
  const toggle = async () => {
    if (!open && !report) await load();
    setOpen(!open);
  };
  const regenerate = async (id) => {
    setBusy(id);
    setMessage(null);
    try {
      await api.regenerateCard(id);
      setMessage({ ok: true, text: 'Card written again. Its quiz answers are made with “Make quiz answers”.' });
      await load();
      await onChanged?.();
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    }
    setBusy(null);
  };

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
      {count > 0 && (
        <button type="button" className="btn btn--quiet" aria-expanded={open} onClick={toggle}>
          {open ? 'Hide cards' : 'Show cards'}
        </button>
      )}
      <p className={message?.ok === false ? 'lesson__extra-text lesson__leak-error' : 'status-ok'} aria-live="polite">
        {message?.text ?? ''}
      </p>
      {open && report && (
        <ul className="lesson__leaks">
          {report.cards.flagged.map((card) => (
            <li key={card.id} className="lesson__extra">
              <p className="lesson__extra-text">
                <span>
                  <strong>{card.front}</strong> → {card.back}
                  <br />
                  {[...new Set(card.rules.map((r) => RULE_TEXT[r.rule]))].join('; ')}
                </span>
              </p>
              {report.can_regenerate && (
                <button type="button" className="btn btn--quiet" onClick={() => regenerate(card.id)} disabled={busy !== null}>
                  {busy === card.id ? 'Writing…' : 'Regenerate this card'}
                </button>
              )}
            </li>
          ))}
          {!report.can_regenerate && (
            <li className="lesson__extra">
              <p className="lesson__extra-text">Participants have studied this lesson, so its cards can’t change now.</p>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
