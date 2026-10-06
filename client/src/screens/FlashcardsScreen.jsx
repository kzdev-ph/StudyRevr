import { useCallback, useEffect, useState } from 'react';
import { CardsIcon, RetryIcon } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import { useAdminPin } from '../lib/admin.js';
import { api } from '../lib/api.js';
import { COUNTS, describeCounts, describeNextDue, studyMinutes, totalDue } from '../lib/flashcards.js';
import { prettyTitle } from '../lib/format.js';
import { paths } from '../lib/router.js';

const POLL_MS = 2500;

// New / Learning / Due, in Anki's colours (blue, red, green from the existing tokens). Every number carries its name,
// so colour is never the only cue; screen readers get the whole thing as one sentence instead.
export function Counts({ counts, current }) {
  return (
    <span className="counts">
      <span className="visually-hidden">{describeCounts(counts, current)}</span>
      <span className="counts__list" aria-hidden="true">
        {COUNTS.map((c) => (
          <span key={c.key} className={`count count--${c.key}${current === c.queue ? ' count--current' : ''}`}>
            <span className="count__n">{counts[c.key]}</span> <span className="count__name">{c.name}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

// The right-hand side of a lesson row: Start, or why there is nothing to start yet.
function DeckAction({ deck, onMake, making, admin }) {
  if (deck.status === 'processing') {
    return (
      <span className="chip chip--busy">
        <span className="spinner spinner--small" aria-hidden="true" /> Preparing
      </span>
    );
  }
  if (deck.status === 'failed') {
    if (!admin) return <span className="deck__total">Not ready yet</span>;
    return (
      <a className="btn btn--quiet" href={paths.lesson(deck.lesson_id)}>
        Open lesson to retry
      </a>
    );
  }
  if (deck.job && deck.job.status !== 'failed') {
    return (
      <span className="chip chip--busy">
        <span className="spinner spinner--small" aria-hidden="true" /> Making cards
      </span>
    );
  }
  if (!deck.total) {
    // making cards calls the AI, so only the researcher (admin) can start it
    if (!admin) return <span className="deck__total">Cards aren’t ready yet</span>;
    return (
      <button type="button" className="btn btn--quiet" onClick={() => onMake(deck.lesson_id)} disabled={making}>
        {deck.job?.status === 'failed' ? <RetryIcon size={18} /> : null}
        {deck.job?.status === 'failed' ? 'Try again' : 'Make cards'}
      </button>
    );
  }
  // Same rule as the All lessons deck: Start when there is something to study, Open when there is not.
  const ready = totalDue(deck.counts) > 0;
  return (
    <a className={`btn ${ready ? 'btn--primary' : 'btn--quiet'}`} href={paths.study(deck.lesson_id)} aria-label={`${ready ? 'Start' : 'Open'} ${prettyTitle(deck.title)}`}>
      {ready ? 'Start' : 'Open'}
    </a>
  );
}

export default function FlashcardsScreen() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [makeError, setMakeError] = useState(null);
  const [making, setMaking] = useState(null); // lesson id while its request is in flight
  const admin = Boolean(useAdminPin());

  const load = useCallback(async (signal) => {
    try {
      setData(await api.listDecks(signal));
      setError(null);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Cards being made (or a lesson still preparing) show up on their own.
  const busy = data?.decks.some((d) => d.status === 'processing' || (d.job && d.job.status !== 'failed'));
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => load(), POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  const make = async (lessonId) => {
    setMakeError(null);
    setMaking(lessonId);
    try {
      await api.makeFlashcards(lessonId);
      await load();
    } catch (err) {
      setMakeError(err.message);
    } finally {
      setMaking(null);
    }
  };

  if (error && !data) {
    return (
      <section className="stack">
        <h1 className="screen-title">Flashcards</h1>
        <Notice action={<button type="button" className="btn btn--quiet btn--small" onClick={() => load()}>Try again</button>}>{error}</Notice>
      </section>
    );
  }
  if (!data) return <p className="muted" aria-live="polite">Loading your flashcards…</p>;

  if (!data.decks.length) {
    return (
      <section className="empty">
        <CardsIcon size={36} className="empty__icon" />
        <h1 className="empty__title">No flashcards yet</h1>
        <p className="empty__text">Flashcards appear here once your teacher adds a lesson.</p>
      </section>
    );
  }

  const { all, limits } = data;
  const allDue = totalDue(all.counts);
  const newLeft = Math.max(0, limits.new_per_day - limits.new_done);
  const failures = data.decks.filter((d) => d.job?.status === 'failed');

  return (
    <section className="stack">
      <h1 className="screen-title">Flashcards</h1>
      {makeError && <Notice onDismiss={() => setMakeError(null)}>{makeError}</Notice>}
      {failures.map((d) => (
        <Notice key={d.lesson_id}>
          <strong>Cards for {prettyTitle(d.title)} weren’t made.</strong> {d.job.error}
        </Notice>
      ))}

      <div className="deck-all">
        <div className="deck-all__text">
          <h2 className="deck-all__title">All lessons</h2>
          <p className="muted">
            {all.total === 0
              ? 'Cards from every lesson show up here.'
              : allDue
                ? `About ${studyMinutes(all.counts)} min for today’s cards.`
                : `All done for today. ${all.next_due_at ? `Next card ${describeNextDue(all.next_due_at)}.` : ''}`}
          </p>
          {allDue > 0 && <Counts counts={all.counts} />}
        </div>
        {all.total > 0 && (
          <a className={`btn ${allDue ? 'btn--primary' : 'btn--quiet'}`} href={paths.study('all')}>
            {allDue ? 'Study all' : 'Open'}
          </a>
        )}
      </div>

      <h2 className="decks-head">Lesson decks</h2>
      <ul className="decks" aria-label="Lessons">
        {data.decks.map((deck) => (
          <li key={deck.lesson_id} className="deck">
            <div className="deck__main">
              <span className="deck__title">{prettyTitle(deck.title)}</span>
              {deck.total > 0 ? (
                <span className="deck__meta">
                  {totalDue(deck.counts) > 0 && <Counts counts={deck.counts} />}
                  <span className="deck__total">
                    {deck.total} {deck.total === 1 ? 'card' : 'cards'}
                    {!totalDue(deck.counts) && deck.next_due_at ? ` · next card ${describeNextDue(deck.next_due_at)}` : ''}
                  </span>
                </span>
              ) : (
                <span className="deck__total">{deck.status === 'ready' && !deck.job ? 'No cards yet' : ' '}</span>
              )}
            </div>
            <DeckAction deck={deck} onMake={make} making={making === deck.lesson_id} admin={admin} />
          </li>
        ))}
      </ul>

      <p className="muted">
        Up to {limits.new_per_day} new cards and {limits.reviews_per_day} reviews a day, across all lessons. {newLeft} new {newLeft === 1 ? 'card' : 'cards'} left
        today. The day starts at 4:00 AM.
      </p>
    </section>
  );
}
