import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate, motion } from 'motion/react';
import { useMotionReduced } from '../lib/motion.js';
import DeckShuffle from '../components/DeckShuffle.jsx';
import FlipCard from '../components/FlipCard.jsx';
import { CardsIcon, CheckIcon, ChevronLeft, UndoIcon } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import { Counts } from './FlashcardsScreen.jsx';
import { useAnswerClock } from '../hooks/useAnswerClock.js';
import { useStudySession } from '../hooks/useStudySession.js';
import { api } from '../lib/api.js';
import { canRate, comesBackToday, describeNextDue, keyAction, RATINGS, sessionRecap, spellInterval } from '../lib/flashcards.js';
import { prettyTitle } from '../lib/format.js';
import { formatDuration } from '../lib/quiz.js';
import { paths } from '../lib/router.js';

const REFRESH_WITHIN_MS = 60 * 60 * 1000; // a card due within the hour is picked up without a reload
const HINT_KEY = 'studyrevr.answered'; // answers on this device, so the button hint only shows to a new student
const HINT_UNTIL = 10;
const DECK_OUT = 'Getting your deck out';
const TURN_FALLBACK_MS = 1500; // the turn should end in ~0.4 s; if its end is never reported, ratings open anyway
const OUT = [0.16, 1, 0.3, 1];
const IN_OUT = [0.4, 0, 0.2, 1];
const PILE_SHOWN = 4; // card edges drawn on the done pile, however many it holds
// how the pile's cards lie: a little askew while it grows, squared up when the deck is finished
const ASKEW = [
  { x: 0, y: 0, rotate: -3 },
  { x: 1, y: -2, rotate: 2 },
  { x: -1, y: -4, rotate: -1.5 },
  { x: 1, y: -6, rotate: 3 },
];
const square = (k) => ({ x: 0, y: -2 * k, rotate: 0 });

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

// The done pile in the margin: the cards answered this sitting that wait a day or more, with how many. It squares up
// when the deck is finished. Decorative: the counts line and the done card's recap say the same in words.
function Pile({ count, squared = false, bump = 0, cardsRef }) {
  const reduce = useMotionReduced();
  const n = useRef(null);
  useLayoutEffect(() => {
    if (bump === 0 || reduce || !n.current) return undefined;
    const run = animate(n.current, { scale: [1.3, 1] }, { duration: 0.2, ease: OUT });
    return () => run.complete();
  }, [bump, reduce]);
  const shown = Math.min(PILE_SHOWN, count);
  return (
    <div className="study-pile" aria-hidden="true">
      <div className="study-pile__cards" ref={cardsRef}>
        {Array.from({ length: shown }, (_, k) => (
          <motion.span
            key={k}
            className="study-pile__card"
            initial={squared ? ASKEW[k] : false}
            animate={squared ? square(k) : ASKEW[k]}
            transition={reduce ? { duration: 0 } : { duration: 0.2, ease: OUT }}
          />
        ))}
      </div>
      {count > 0 ? (
        <span className="study-pile__count">
          <span className="mnote__n study-pile__n" ref={n}>
            {count}
          </span>
          <span className="mnote__label">done</span>
        </span>
      ) : null}
    </div>
  );
}

// The card just answered, on its way from behind the next one: down under the deck (it comes back today) or onto the
// done pile (it waits a day or more); after an undo the same way back. The next card is on top and usable from its
// first frame; this only moves under it.
function Ghost({ dest, reverse, deskRef, pileRef, onDone }) {
  const ref = useRef(null);
  const done = useRef(onDone);
  done.current = onDone;
  useLayoutEffect(() => {
    const el = ref.current;
    let frames;
    let options;
    if (dest === 'pile' && pileRef.current && deskRef.current) {
      const pile = pileRef.current.getBoundingClientRect();
      const desk = deskRef.current.getBoundingClientRect();
      el.style.transformOrigin = '0 0';
      frames = {
        x: [0, pile.left - desk.left],
        y: [0, pile.top - desk.top],
        scaleX: [1, pile.width / desk.width],
        scaleY: [1, pile.height / desk.height],
        rotate: [0, -3],
      };
      options = { duration: 0.3, ease: OUT };
    } else {
      frames = { y: [0, 30], scale: [1, 0.96], opacity: [1, 0] };
      options = { duration: 0.26, ease: IN_OUT };
    }
    if (reverse) for (const key of Object.keys(frames)) frames[key].reverse();
    let live = true;
    const run = animate(el, frames, reverse ? { ...options, ease: OUT } : options);
    run.then(() => live && done.current());
    return () => {
      live = false;
      run.stop();
    };
  }, [dest, reverse, deskRef, pileRef]);
  return (
    <div className="study-ghost" ref={ref} aria-hidden="true">
      <span className="study-ghost__line" />
      <span className="study-ghost__line" />
    </div>
  );
}

// One study session on a deck (`deck`: a lesson id or 'all'). The server picks every card (learning, then due
// reviews, then new, within the daily limits); this screen gets the deck out, shows each card, times the answer
// (useAnswerClock: the deck coming out and the card turning over are never counted), and can undo.
export default function StudyScreen({ deck }) {
  const [state, setState] = useState(null); // the server's study state: { deck, counts, total, card, next_due_at }
  const [error, setError] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [turned, setTurned] = useState(false); // the answer side has finished turning: only then can the card be rated
  const [busy, setBusy] = useState(false);
  const [undoStack, setUndoStack] = useState([]); // { id, rating, dest } answered in this session, newest last
  const [answered, setAnswered] = useState(0);
  const [ratings, setRatings] = useState([]); // every answer on this screen, minus undone ones (the done card's recap)
  const [undone, setUndone] = useState(null); // 'Undid Good.' after an undo, until the next answer
  const [announce, setAnnounce] = useState(''); // read out by the live region that is always on the page
  const [showHint] = useState(() => readAnswered() < HINT_UNTIL);
  const [shuffling, setShuffling] = useState(false); // the deck coming out, once each time a deck is opened
  const [ghost, setGhost] = useState(null); // { id, dest, reverse }: the answered card on its way
  const [piled, setPiled] = useState(0); // answers this sitting that went onto the done pile
  const [bump, setBump] = useState(0); // a card landed on the pile: its count ticks up
  const showButton = useRef(null);
  const ratingGroup = useRef(null);
  const doneHeading = useRef(null);
  const deskRef = useRef(null);
  const pileRef = useRef(null);
  const focusAfter = useRef(null); // 'show' | 'rate': where focus goes after the next render
  const reduce = useMotionReduced();
  const { clock, show, showAtPaint } = useAnswerClock(); // the card's time_ms
  const activeMs = useStudySession(deck === 'all' ? null : deck, 'flashcards');

  // A new card on top: usable from its first frame. While the deck is coming out it is not on screen yet.
  const take = useCallback(
    (next, { opening = false } = {}) => {
      setState((prev) => ({ ...next, deck: next.deck ?? prev?.deck }));
      setRevealed(false);
      setTurned(false);
      if (opening) show();
      else showAtPaint();
      focusAfter.current = 'show';
    },
    [show, showAtPaint],
  );

  // `opening`: the first load when the deck is opened, which gets the deck out (never a reload or an undo)
  const load = useCallback(
    async (signal, opening = false) => {
      try {
        const next = await api.getDue(deck, signal);
        const out = opening && Boolean(next.card);
        take(next, { opening: out });
        if (out) setShuffling(true);
        setError(null);
      } catch (err) {
        if (err.name !== 'AbortError') setError(err.message);
      }
    },
    [deck, take],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal, true);
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
    if (shuffling) return; // the deck coming out holds focus itself; this waits for the first card
    // no Show answer button means the deck is done: focus its heading rather than letting focus drop to the page
    if (focusAfter.current === 'show') (showButton.current ?? doneHeading.current)?.focus({ preventScroll: true });
    if (focusAfter.current === 'rate') ratingGroup.current?.focus({ preventScroll: true });
    focusAfter.current = null;
  });

  // "Getting your deck out" is read by the live region that is always on the page. It is set a moment after the deck
  // appears: text that is already in a live region when it is inserted is often not read.
  useEffect(() => {
    if (!shuffling) {
      setAnnounce((a) => (a === DECK_OUT ? '' : a));
      return undefined;
    }
    const timer = setTimeout(() => setAnnounce(DECK_OUT), 150);
    return () => clearTimeout(timer);
  }, [shuffling]);

  // The deck is out (or skipped): the first card is on top.
  const shuffled = useCallback(() => {
    setShuffling(false);
    showAtPaint();
    focusAfter.current = 'show';
  }, [showAtPaint]);

  // Show answer: the card turns over, and the clock waits until the answer side is fully shown (FlipCard's onTurned).
  const reveal = useCallback(() => {
    if (revealed) return;
    clock.input();
    clock.pause('flip');
    setRevealed(true);
    focusAfter.current = 'rate';
  }, [clock, revealed]);
  const onTurned = useCallback(() => {
    clock.resume('flip');
    setTurned(true);
  }, [clock]);
  useEffect(() => {
    if (!revealed || turned) return undefined;
    const timer = setTimeout(onTurned, TURN_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [revealed, turned, onTurned]);

  const rate = useCallback(
    async (rating) => {
      if (!state?.card || busy || !canRate({ revealed, turned })) return;
      // where the card goes on screen, from the button pressed (the next card brings new buttons)
      const dest = comesBackToday(state.card.buttons.find((b) => b.rating === rating)) ? 'deck' : 'pile';
      setBusy(true);
      setError(null);
      clock.input();
      const timeMs = clock.stop();
      try {
        const next = await api.answerCard(state.card.id, { rating, timeMs, deck });
        setUndoStack((s) => [...s, { id: next.review_id, rating, dest }]);
        setRatings((r) => [...r, rating]);
        setAnswered((n) => n + 1);
        if (dest === 'pile') setPiled((n) => n + 1);
        setUndone(null);
        setAnnounce('');
        countAnswer();
        take(next);
        setGhost(next.card && !reduce ? { id: `a${next.review_id}`, dest, reverse: false } : null);
      } catch (err) {
        // the card was already answered elsewhere (another tab) and isn't due any more, or that tab used up the day's new
        // cards: just reload the deck, which no longer offers it
        if (err.code === 'not_due' || err.code === 'new_limit') await load();
        else {
          clock.reopen(); // still on this card: its time carries on
          setError(err.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [state, busy, revealed, turned, deck, take, load, clock, reduce],
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
      if (last.dest === 'pile') setPiled((n) => Math.max(0, n - 1));
      setUndone(`Undid ${name}.`);
      setAnnounce(`Undid ${name}. Back to: ${next.card?.front ?? 'the last card'}`);
      take(next);
      setGhost(next.card && !reduce ? { id: `u${last.id}`, dest: last.dest, reverse: true } : null);
    } catch (err) {
      setError(err.message);
      if (err.status === 404 || err.status === 409) setUndoStack([]);
    } finally {
      setBusy(false);
    }
  }, [undoStack, busy, deck, take, reduce]);

  useEffect(() => {
    const onKey = (event) => {
      if (shuffling || event.repeat) return; // DeckShuffle takes Enter / Space / Escape to skip; a held key does nothing
      const action = keyAction(event, { revealed, ready: canRate({ revealed, turned }) });
      if (!action) return;
      event.preventDefault();
      if (action === 'undo') undo();
      else if (busy || !state?.card) return;
      else if (action === 'flip') reveal();
      else rate(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shuffling, revealed, turned, busy, state, undo, reveal, rate]);

  const landed = useCallback(() => {
    if (ghost?.dest === 'pile' && !ghost.reverse) setBump((b) => b + 1);
    setGhost(null);
  }, [ghost]);

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

      {card && shuffling ? (
        <DeckShuffle onDone={shuffled} />
      ) : card ? (
        <>
          {/* the card on the deck: two card edges under it, the done pile in the margin beside it */}
          <div className="study-desk" ref={deskRef}>
            <Pile count={piled} bump={bump} cardsRef={pileRef} />
            {ghost && <Ghost key={ghost.id} dest={ghost.dest} reverse={ghost.reverse} deskRef={deskRef} pileRef={pileRef} onDone={landed} />}
            <div className="study-desk__card">
              <FlipCard key={`${card.id}-${answered}-${undoStack.length}`} card={card} revealed={revealed} onReveal={reveal} onTurned={onTurned} showLesson={deck === 'all'} />
            </div>
          </div>

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
                      <button key={b.rating} type="button" className={`rate__btn rate__btn--${tone}`} onClick={() => rate(b.rating)} disabled={busy} aria-disabled={turned ? undefined : true} aria-label={`${name}, next in ${spellInterval(b.label)}`}>
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
          <div className="study-desk study-desk--done">
            {piled > 0 ? <Pile count={piled} squared /> : null}
            <DoneCard state={state} recap={sessionRecap(ratings, activeMs())} deck={deck} headingRef={doneHeading} arrive={answered > 0 && !reduce} after={piled > 0} />
          </div>
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

// `arrive`: the deck was just finished on this screen, so the done card comes in (after the pile has squared up when
// there is one, `after`).
function DoneCard({ state, recap, deck, headingRef, arrive = false, after = false }) {
  const empty = state.total === 0;
  const next = describeNextDue(state.next_due_at);
  const soon = state.next_due_at && Date.parse(state.next_due_at) - Date.now() < REFRESH_WITHIN_MS;
  return (
    <motion.div className="done" initial={arrive ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: after ? 0.16 : 0, ease: OUT }}>
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
    </motion.div>
  );
}
