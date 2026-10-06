import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import FlipCard from '../components/FlipCard.jsx';
import { CardsIcon, CheckIcon, ChevronLeft, UndoIcon } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import { Counts } from './FlashcardsScreen.jsx';
import { useStudySession } from '../hooks/useStudySession.js';
import { api } from '../lib/api.js';
import { describeNextDue, keyAction, RATINGS, sessionRecap, spellInterval } from '../lib/flashcards.js';
import { prettyTitle } from '../lib/format.js';
import { formatDuration } from '../lib/quiz.js';
import { paths } from '../lib/router.js';

const REFRESH_WITHIN_MS = 60 * 60 * 1000; // a card due within the hour is picked up without a reload
const HINT_KEY = 'studyrevr.answered'; // answers on this device, so the button hint only shows to a new student
const HINT_UNTIL = 10;

const readAnswered = () => {
  try {
    return Number(window.localStorage.getItem(HINT_KEY)) || 0;
  } catch {
    return HINT_UNTIL;
  }
};
const countAnswer = () => {
  try {
    window.localStorage.setItem(HINT_KEY, String(readAnswered() + 1));
  } catch {
    // no storage: nothing to remember
  }
};

// One study session on a deck (`deck`: a lesson id or 'all'). The server picks every card (learning, then due
// reviews, then new, within the daily limits); this screen shows it, times the answer, and can undo.
export default function StudyScreen({ deck }) {
  const [state, setState] = useState(null); // the server's study state: { deck, counts, total, card, next_due_at }
  const [error, setError] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undoStack, setUndoStack] = useState([]); // { id, rating } answered in this session, newest last
  const [answered, setAnswered] = useState(0);
  const [ratings, setRatings] = useState([]); // every answer on this screen, minus undone ones (the done card's recap)
  const [undone, setUndone] = useState(null); // 'Undid Good.' after an undo, until the next answer
  const [announce, setAnnounce] = useState(''); // read out by the live region that is always on the page
  const [showHint] = useState(() => readAnswered() < HINT_UNTIL);
  const shownAt = useRef(0);
  const showButton = useRef(null);
  const ratingGroup = useRef(null);
  const doneHeading = useRef(null);
  const focusAfter = useRef(null); // 'show' | 'rate': where focus goes after the next render
  const activeMs = useStudySession(deck === 'all' ? null : deck, 'flashcards');

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
    // no Show answer button means the deck is done: focus its heading rather than letting focus drop to the page
    if (focusAfter.current === 'show') (showButton.current ?? doneHeading.current)?.focus({ preventScroll: true });
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
        setUndoStack((s) => [...s, { id: next.review_id, rating }]);
        setRatings((r) => [...r, rating]);
        setAnswered((n) => n + 1);
        setUndone(null);
        setAnnounce('');
        countAnswer();
        take(next);
      } catch (err) {
        // the card was already answered elsewhere (another tab) and isn't due any more, or that tab used up the day's new
        // cards: just reload the deck, which no longer offers it
        if (err.code === 'not_due' || err.code === 'new_limit') await load();
        else setError(err.message);
      } finally {
        setBusy(false);
      }
    },
    [state, busy, deck, take, load],
  );

  const undo = useCallback(async () => {
    const last = undoStack.at(-1);
    if (!last || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.undoAnswer(last.id, deck);
      const { name } = RATINGS[last.rating - 1];
      setUndoStack((s) => s.slice(0, -1));
      setRatings((r) => r.slice(0, -1));
      setAnswered((n) => Math.max(0, n - 1));
      setUndone(`Undid ${name}.`);
      setAnnounce(`Undid ${name}. Back to: ${next.card?.front ?? 'the last card'}`);
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
      <p className="muted" aria-live="polite">Getting your cards…</p>
    );
  }

  const title = state.deck?.lesson_id ? prettyTitle(state.deck.title) : 'All lessons';
  const { card } = state;
  const undoBar = (undoStack.length > 0 || undone) && <UndoBar undone={undone} onUndo={undo} disabled={!undoStack.length || busy} />;
  const errorNotice = error && <Notice onDismiss={() => setError(null)}>{error}</Notice>;

  return (
    <section className="study">
      <header className="study-head">
        {back}
        <div className="study-head__text">
          <h1 className="study-head__title">{title}</h1>
          <Counts counts={state.counts} current={card?.queue} />
        </div>
      </header>

      {/* With a card on screen, errors and undo sit in the pinned bar, next to the buttons that caused them. */}
      {!card && errorNotice}

      {card ? (
        <>
          <motion.div key={`${card.id}-${answered}-${undoStack.length}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
            <FlipCard card={card} revealed={revealed} onReveal={reveal} showLesson={deck === 'all'} />
          </motion.div>

          <div className="study-actions">
            {errorNotice}
            {undoBar}
            {revealed ? (
              <>
                {showHint && <p className="rate-hint">Again brings the card back soon. Easy waits the longest.</p>}
                <div className="rate" role="group" aria-label="How well did you remember it?" aria-describedby="study-answer" tabIndex={-1} ref={ratingGroup}>
                  {card.buttons.map((b) => {
                    const { name, tone } = RATINGS[b.rating - 1];
                    return (
                      <button key={b.rating} type="button" className={`rate__btn rate__btn--${tone}`} onClick={() => rate(b.rating)} disabled={busy} aria-label={`${name}, next in ${spellInterval(b.label)}`}>
                        <span className="rate__name">{name}</span>
                        <span className="rate__ivl">{b.label}</span>
                        <kbd className="rate__key" aria-hidden="true">{b.rating}</kbd>
                      </button>
                    );
                  })}
                </div>
                {/* read once, together with the group, when focus lands on it after the flip */}
                <p id="study-answer" className="visually-hidden">
                  Answer: {card.back}
                  {card.evidence ? ` From the lesson: ${card.evidence}` : ''}
                </p>
              </>
            ) : (
              <button type="button" className="btn btn--primary study-show" onClick={reveal} ref={showButton} disabled={busy}>
                Show answer <kbd className="study-show__key" aria-hidden="true">Space</kbd>
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <DoneCard state={state} recap={sessionRecap(ratings, activeMs())} deck={deck} headingRef={doneHeading} />
          {undoBar}
        </>
      )}

      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}

// Undo the last answer (several levels, within this session). It sits beside the answer buttons, where a mis-tap
// happens, and says what it undid.
function UndoBar({ undone, onUndo, disabled }) {
  return (
    <div className="undo-bar">
      <p className="undo-bar__status">{undone}</p>
      <button type="button" className="study-undo" onClick={onUndo} disabled={disabled} title="Undo the last answer (U or Ctrl+Z)" aria-keyshortcuts="U Control+Z">
        <UndoIcon size={20} /> <span>Undo</span>
      </button>
    </div>
  );
}

// What this sitting added up to: cards studied, active time and the share answered Good or Easy.
function Recap({ recap }) {
  if (!recap.cards) return null;
  return (
    <div className="recap-group" role="group" aria-label="This session">
      <dl className="recap">
        <div className="recap__item">
          <dt>Cards studied</dt>
          <dd>{recap.cards}</dd>
        </div>
        <div className="recap__item">
          <dt>Active time</dt>
          <dd>{formatDuration(recap.timeMs)}</dd>
        </div>
        <div className="recap__item recap__item--peak">
          <dt>Good or Easy answers</dt>
          <dd>{recap.goodEasyPct}%</dd>
        </div>
      </dl>
    </div>
  );
}

function DoneCard({ state, recap, deck, headingRef }) {
  const empty = state.total === 0;
  const next = describeNextDue(state.next_due_at);
  const soon = state.next_due_at && Date.parse(state.next_due_at) - Date.now() < REFRESH_WITHIN_MS;
  return (
    <div className="done">
      {empty ? <CardsIcon size={36} className="done__icon done__icon--empty" /> : <CheckIcon size={36} className="done__icon" />}
      <h2 className="done__title" tabIndex={-1} ref={headingRef}>{empty ? 'No cards in this deck yet' : soon ? 'Done for now' : 'Done for today'}</h2>
      <p className="done__text">
        {empty
          ? 'Cards are made when a lesson finishes preparing. If this lesson has none, ask your teacher to make them.'
          : next
            ? `The next card is due ${next}.`
            : 'No more cards are scheduled.'}
      </p>
      <Recap recap={recap} />
      {soon && <p className="muted">The card appears here when it’s due.</p>}
      <div className="done__actions">
        {deck === 'all' ? (
          <a className="btn btn--primary" href={paths.tab('flashcards')}>
            All decks
          </a>
        ) : (
          <>
            {/* the quiz is made from the cards, so a deck with none can only go back to the lesson */}
            {!empty && (
              <a className="btn btn--primary" href={paths.quiz(deck)}>
                Take the mock quiz
              </a>
            )}
            <a className={`btn ${empty ? 'btn--primary' : 'btn--quiet'}`} href={paths.lesson(deck)}>
              Read the lesson
            </a>
            <a className="btn btn--quiet" href={paths.tab('flashcards')}>
              All decks
            </a>
          </>
        )}
      </div>
    </div>
  );
}
