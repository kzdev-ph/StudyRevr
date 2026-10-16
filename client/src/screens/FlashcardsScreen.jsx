import { useCallback, useEffect, useState } from 'react';
import { CardsIcon, CheckIcon } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import { api } from '../lib/api.js';
import { COUNTS, describeCounts, describeNextDue, studyMinutes, totalDue } from '../lib/flashcards.js';
import { prettyTitle } from '../lib/format.js';
import { paths } from '../lib/router.js';

const POLL_MS = 2500;

// New / Learning / Due: blue, pencil amber and green. Every number carries its name, so colour is never the only cue;
// screen readers get the whole thing as one sentence instead.
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

// Written in the margin beside a deck: how many cards are waiting today, or a check when the deck is done for now.
// The counts in the card say the same in words, so screen readers skip it.
function MarginCount({ counts, total }) {
  if (!total) return null;
  const n = totalDue(counts);
  return n ? (
    <span className="mnote mnote--due" aria-hidden="true">
      <span className="mnote__n">{n}</span>
      <span className="mnote__label">today</span>
    </span>
  ) : (
    <span className="mnote mnote--done" aria-hidden="true">
      <CheckIcon size={24} />
    </span>
  );
}

// The right-hand side of a lesson row: Start, or why there is nothing to start yet.
function DeckAction({ deck }) {
  if (deck.status === 'processing') {
    return (
      <span className="chip chip--busy">
        <span className="spinner spinner--small" aria-hidden="true" /> Preparing
      </span>
    );
  }
  // a lesson that failed is retried by the teacher from admin's lesson list
  if (deck.status === 'failed') return <span className="deck__total">Not ready yet</span>;
  if (deck.job && deck.job.status !== 'failed') {
    return (
      <span className="chip chip--busy">
        <span className="spinner spinner--small" aria-hidden="true" /> Making cards
      </span>
    );
  }
  // cards are made by the teacher from admin's lesson list (it calls the AI)
  if (!deck.total) return <span className="deck__total">Cards aren’t ready yet</span>;
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
      {failures.map((d) => (
        <Notice key={d.lesson_id}>
          <strong>Cards for {prettyTitle(d.title)} weren’t made.</strong> {d.job.error}
        </Notice>
      ))}

      <div className="deck-layout">
        <div className="deck-layout__side">
          <div className="deck-all">
            <MarginCount counts={all.counts} total={all.total} />
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

          <p className="muted">
            Up to {limits.new_per_day} new cards and {limits.reviews_per_day} reviews a day, across all lessons. {newLeft} new {newLeft === 1 ? 'card' : 'cards'} left
            today. The day starts at 4:00 AM.
          </p>
        </div>

        <div className="deck-layout__decks">
          <h2 className="decks-head">Lesson decks</h2>
          <ul className="decks" aria-label="Lessons">
            {data.decks.map((deck) => (
              <li key={deck.lesson_id} className="deck">
                <MarginCount counts={deck.counts} total={deck.total} />
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
                <DeckAction deck={deck} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
