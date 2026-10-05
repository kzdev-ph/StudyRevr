import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import FlipCard from '../components/FlipCard.jsx';
import { CheckIcon, ChevronLeft, UndoIcon } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import { Counts } from './FlashcardsScreen.jsx';
import { api } from '../lib/api.js';
import { describeNextDue, keyAction, RATINGS } from '../lib/flashcards.js';
import { prettyTitle } from '../lib/format.js';
import { paths } from '../lib/router.js';

const REFRESH_WITHIN_MS = 60 * 60 * 1000; // a card due within the hour is picked up without a reload

// One study session on a deck (`deck`: a lesson id or 'all'). The server picks every card (learning, then due
// reviews, then new, within the daily limits); this screen shows it, times the answer, and can undo.
export default function StudyScreen({ deck }) {
  const [state, setState] = useState(null); // the server's study state: { deck, counts, total, card, next_due_at }
  const [error, setError] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undoStack, setUndoStack] = useState([]); // review ids answered in this session, newest last
  const [answered, setAnswered] = useState(0);
  const shownAt = useRef(0);
  const showButton = useRef(null);
  const ratingGroup = useRef(null);
  const focusAfter = useRef(null); // 'show' | 'rate': where focus goes after the next render

  const take = useCallback((next) => {
    setState((prev) => ({ ...next, deck: next.deck ?? prev?.deck }));
    setRevealed(false);
    shownAt.current = performance.now();
    focusAfter.current = 'show';
  }, []);

  const load = useCallback(
    async (signal) => {
      try {
        take(await api.getDue(deck, signal));
        setError(null);
      } catch (err) {
        if (err.name !== 'AbortError') setError(err.message);
      }
    },
    [deck, take],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Done for now, but a learning card comes back soon: fetch it when it is due.
  useEffect(() => {
    if (state?.card || !state?.next_due_at) return undefined;
    const wait = Date.parse(state.next_due_at) - Date.now();
    if (wait > REFRESH_WITHIN_MS) return undefined;
    const timer = setTimeout(() => load(), Math.max(1000, wait + 500));
    return () => clearTimeout(timer);
  }, [state, load]);

  useEffect(() => {
    if (focusAfter.current === 'show') showButton.current?.focus({ preventScroll: true });
    if (focusAfter.current === 'rate') ratingGroup.current?.focus({ preventScroll: true });
    focusAfter.current = null;
  });

  const reveal = useCallback(() => {
    setRevealed(true);
    focusAfter.current = 'rate';
  }, []);

  const rate = useCallback(
    async (rating) => {
      if (!state?.card || busy) return;
      setBusy(true);
      setError(null);
      try {
        const timeMs = Math.round(performance.now() - shownAt.current);
        const next = await api.answerCard(state.card.id, { rating, timeMs, deck });
        setUndoStack((s) => [...s, next.review_id]);
        setAnswered((n) => n + 1);
        take(next);
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    },
    [state, busy, deck, take],
  );

  const undo = useCallback(async () => {
    const reviewId = undoStack.at(-1);
    if (!reviewId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.undoAnswer(reviewId, deck);
      setUndoStack((s) => s.slice(0, -1));
      setAnswered((n) => Math.max(0, n - 1));
      take(next);
    } catch (err) {
      setError(err.message);
      if (err.status === 404 || err.status === 409) setUndoStack([]);
    } finally {
      setBusy(false);
    }
  }, [undoStack, busy, deck, take]);

  useEffect(() => {
    const onKey = (event) => {
      const action = keyAction(event, { revealed });
      if (!action) return;
      event.preventDefault();
      if (action === 'undo') undo();
      else if (busy || !state?.card) return;
      else if (action === 'flip') reveal();
      else rate(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealed, busy, state, undo, reveal, rate]);

  const back = (
    <a className="icon-btn" href={paths.tab('flashcards')} aria-label="All decks" title="All decks">
      <ChevronLeft />
    </a>
  );

  if (!state) {
    return error ? (
      <section className="stack">
        <a className="back" href={paths.tab('flashcards')}>
          <ChevronLeft size={18} /> All decks
        </a>
        <Notice action={<button type="button" className="btn btn--quiet btn--small" onClick={() => load()}>Try again</button>}>{error}</Notice>
      </section>
    ) : (
      <p className="muted" aria-live="polite">Shuffling your cards…</p>
    );
  }

  const title = state.deck?.lesson_id ? prettyTitle(state.deck.title) : 'All lessons';
  const { card } = state;

  return (
    <section className="study">
      <header className="study-head">
        {back}
        <div className="study-head__text">
          <h1 className="study-head__title">{title}</h1>
          <Counts counts={state.counts} current={card?.queue} />
        </div>
        <button type="button" className="study-undo" onClick={undo} disabled={!undoStack.length || busy} title="Undo the last answer (U or Ctrl+Z)">
          <UndoIcon size={20} /> <span>Undo</span>
        </button>
      </header>

      {error && <Notice onDismiss={() => setError(null)}>{error}</Notice>}

      {card ? (
        <>
          <motion.div key={`${card.id}-${answered}-${undoStack.length}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
            <FlipCard card={card} revealed={revealed} onReveal={reveal} showLesson={deck === 'all'} />
          </motion.div>

          <div className="study-actions">
            {revealed ? (
              <div className="rate" role="group" aria-label="How well did you remember it?" tabIndex={-1} ref={ratingGroup}>
                {card.buttons.map((b) => {
                  const { name, tone } = RATINGS[b.rating - 1];
                  return (
                    <button key={b.rating} type="button" className={`rate__btn rate__btn--${tone}`} onClick={() => rate(b.rating)} disabled={busy} aria-label={`${name}, next in ${b.label}`}>
                      <span className="rate__name">{name}</span>
                      <span className="rate__ivl">{b.label}</span>
                      <kbd className="rate__key" aria-hidden="true">{b.rating}</kbd>
                    </button>
                  );
                })}
              </div>
            ) : (
              <button type="button" className="btn btn--primary study-show" onClick={reveal} ref={showButton} disabled={busy}>
                Show answer <kbd className="study-show__key" aria-hidden="true">Space</kbd>
              </button>
            )}
          </div>
          <p className="visually-hidden" aria-live="polite">
            {revealed ? `Answer: ${card.back}` : ''}
          </p>
        </>
      ) : (
        <DoneCard state={state} answered={answered} deck={deck} />
      )}
    </section>
  );
}

function DoneCard({ state, answered, deck }) {
  const empty = state.total === 0;
  const next = describeNextDue(state.next_due_at);
  const soon = state.next_due_at && Date.parse(state.next_due_at) - Date.now() < REFRESH_WITHIN_MS;
  return (
    <div className="done" role="status">
      <CheckIcon size={36} className="done__icon" />
      <h2 className="done__title">{empty ? 'No cards in this deck yet' : soon ? 'Done for now' : 'Done for today'}</h2>
      <p className="done__text">
        {empty
          ? 'Cards are made when a lesson finishes preparing. Lessons uploaded earlier can get theirs from the Flashcard tab.'
          : `${answered ? `You answered ${answered} ${answered === 1 ? 'card' : 'cards'}. ` : ''}${next ? `The next card is due ${next}.` : 'No more cards are scheduled.'}`}
      </p>
      {soon && <p className="muted">Keep this page open and it comes up on its own.</p>}
      <div className="done__actions">
        <a className="btn btn--primary" href={paths.tab('flashcards')}>
          All decks
        </a>
        {deck !== 'all' && (
          <a className="btn btn--quiet" href={paths.lesson(deck)}>
            Read the lesson
          </a>
        )}
      </div>
    </div>
  );
}
