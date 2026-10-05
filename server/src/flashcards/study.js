import { HttpError } from '../middleware/errors.js';
import { answer, buildQueue, NEW, previewAnswers, queueOf, REVIEW, studyDay } from './scheduler.js';

// The database side of studying: which deck, what was done today, saving an answer and undoing it.
// A deck is one lesson's cards (`lessonId`) or every card ("All lessons", lessonId null). Daily limits are one
// budget for the whole day across all lessons, like a parent deck in Anki.

const CARD_COLUMNS = `f.id, f.lesson_id, f.kind, f.front, f.back, f.evidence, f.state, f.ease, f.interval, f.due_at,
  f.reps, f.lapses, f.step, l.title AS lesson_title`;
const SCHEDULING = ['state', 'step', 'ease', 'interval', 'due_at', 'reps', 'lapses'];

// New cards come in lesson order (oldest lesson first), then in the order they were made.
export function deckCards(db, lessonId = null) {
  return db
    .prepare(
      `SELECT ${CARD_COLUMNS} FROM flashcards f JOIN lessons l ON l.id = f.lesson_id
       WHERE (@lessonId IS NULL OR f.lesson_id = @lessonId)
       ORDER BY l.created_at, l.id, f.position, f.id`,
    )
    .all({ lessonId });
}

// { newCards, reviews } answered since the study day began, over all lessons. A new card counts once: after its
// first answer it is no longer new.
export function doneToday(db, dayStart) {
  const rows = db.prepare('SELECT state, COUNT(*) AS n FROM flashcard_reviews WHERE reviewed_at >= ? GROUP BY state').all(dayStart.toISOString());
  const count = (state) => rows.find((r) => r.state === state)?.n ?? 0;
  return { newCards: count(NEW), reviews: count(REVIEW) };
}

// A card as the study screen needs it, with what each button would do.
export function cardView(card, queue, { now, config }) {
  return {
    id: card.id,
    lesson_id: card.lesson_id,
    lesson_title: card.lesson_title,
    kind: card.kind,
    front: card.front,
    back: card.back,
    evidence: card.evidence,
    state: card.state,
    queue,
    buttons: previewAnswers(card, { now, config }),
  };
}

// The study screen's state for a deck: counts, the card to show (or none) and, when there is none, when the next
// one is due. `showFirst` puts that card up next whatever the queue says (Undo brings the undone card back).
export function studyState(db, { lessonId = null, now, config, showFirst } = {}) {
  const cards = deckCards(db, lessonId);
  const { start } = studyDay(now, config);
  const q = buildQueue(cards, { now, config, doneToday: doneToday(db, start) });
  let { card, queue } = q;
  const forced = showFirst && cards.find((c) => c.id === showFirst);
  if (forced) [card, queue] = [forced, queueOf(forced)];
  return {
    counts: q.counts,
    total: cards.length,
    card: card ? cardView(card, queue, { now, config }) : null,
    next_due_at: card ? null : q.nextDueAt?.toISOString() ?? null,
    day: { start: q.day.start.toISOString(), end: q.day.end.toISOString() },
  };
}

const MAX_TIME_MS = 60 * 60 * 1000;

// Applies one answer and writes its review-log row in one transaction. -> { review_id, card }
export function recordAnswer(db, { cardId, rating, timeMs = 0, now, config }) {
  return db.transaction(() => {
    const card = db.prepare(`SELECT ${CARD_COLUMNS} FROM flashcards f JOIN lessons l ON l.id = f.lesson_id WHERE f.id = ?`).get(cardId);
    if (!card) throw new HttpError(404, 'Flashcard not found.');
    const result = answer(card, rating, { now, config });
    const next = result.card;
    db.prepare(
      `UPDATE flashcards SET state = @state, step = @step, ease = @ease, interval = @interval, due_at = @due_at,
         reps = @reps, lapses = @lapses WHERE id = @id`,
    ).run({ ...next, id: card.id });
    const snapshot = JSON.stringify(Object.fromEntries(SCHEDULING.map((k) => [k, card[k]])));
    const reviewId = Number(
      db
        .prepare(
          `INSERT INTO flashcard_reviews (flashcard_id, rating, reviewed_at, prev_interval, new_interval, state, ease, time_ms, snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(card.id, rating, now.toISOString(), card.interval, result.newInterval, card.state, next.ease, Math.round(Math.min(Math.max(timeMs, 0), MAX_TIME_MS)), snapshot)
        .lastInsertRowid,
    );
    return { review_id: reviewId, card: { ...card, ...next } };
  })();
}

// Puts the card back exactly as it was before the answer and removes that answer from the log. Only a card's most
// recent answer can be undone (an older one would rewind over the answers after it). -> the restored card's id
export function undoAnswer(db, reviewId) {
  return db.transaction(() => {
    const review = db.prepare('SELECT id, flashcard_id, snapshot FROM flashcard_reviews WHERE id = ?').get(reviewId);
    if (!review) throw new HttpError(404, 'That answer was not found. It may have been undone already.');
    const latest = db.prepare('SELECT MAX(id) AS id FROM flashcard_reviews WHERE flashcard_id = ?').get(review.flashcard_id).id;
    if (latest !== review.id || !review.snapshot) throw new HttpError(409, 'Only the last answer on a card can be undone.');
    const before = JSON.parse(review.snapshot);
    db.prepare(
      `UPDATE flashcards SET state = @state, step = @step, ease = @ease, interval = @interval, due_at = @due_at,
         reps = @reps, lapses = @lapses WHERE id = @id`,
    ).run({ ...before, id: review.flashcard_id });
    db.prepare('DELETE FROM flashcard_reviews WHERE id = ?').run(review.id);
    return review.flashcard_id;
  })();
}
