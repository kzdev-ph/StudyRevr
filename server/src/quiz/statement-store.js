import { quizCandidates } from './build.js';
import { listGroups, siblingItems } from './list-items.js';
import { cardHash } from './review-flags.js';

// The saved true / false statement pairs of a lesson's concept cards (table quiz_statements, migration 021). Written by
// services/quiz-statements.js, checked by the AI review (services/quiz-review.js) and read by the quiz builder through
// quizBuildOptions (options.js, which imports this file: keep it from importing options.js back).

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const lessonTextOf = (db, lessonId) => db.prepare('SELECT raw_text FROM lessons WHERE id = ?').get(lessonId)?.raw_text ?? '';

// Map card id -> { card_hash, true_text, false_text, status, why } for every saved row of the lesson, or undefined on a
// database from before migration 021 (`npm run quiz:check` opens any StudyRevr database read-only). A row whose
// card_hash is not the card's current one is still returned: the builder compares the hash (cardHash, review-flags.js).
export function loadStatements(db, lessonId) {
  if (!hasTable(db, 'quiz_statements')) return undefined;
  const rows = db
    .prepare(
      `SELECT s.flashcard_id, s.card_hash, s.true_text, s.false_text, s.status, s.why FROM quiz_statements s
       JOIN flashcards f ON f.id = s.flashcard_id WHERE f.lesson_id = ?`,
    )
    .all(lessonId);
  return new Map(rows.map(({ flashcard_id, ...row }) => [flashcard_id, row]));
}

// The reason saved with a row for a card the AI's reply left out (services/quiz-statements.js). Such a row settles
// nothing about the card, so the card is asked for again; a row rejected by the code checks stays settled.
export const NOT_IN_REPLY = 'no statement in the reply';

// A long answer or a question for steps cannot be one true sentence with one swapped part: such cards get no pair.
export const MAX_ANSWER_WORDS = 12;
export const STEPS_QUESTION = /\b(steps?|procedure|process of|how do you|how to|mga hakbang|paano)\b/i;
const wantsLongAnswer = (c) => (String(c.back ?? '').match(/\S+/g)?.length ?? 0) > MAX_ANSWER_WORDS || STEPS_QUESTION.test(c.front ?? '');

// Concept cards that get a pair and have none for their current text: not list items (their Yes/No keeps the form of
// the list), not a long answer or a question for steps (they stay multiple choice), and none that the quiz never asks
// (rules a, k, l, m, o of quizCandidates: the question holds the answer, the answer restates it, a vague or
// objectives-only card). A row for the current text settles the card, except one saved only because the reply left the
// card out. -> [{ id, front, back, evidence }] in position, id order
export function cardsNeedingStatements(db, lessonId) {
  const cards = db.prepare('SELECT id, kind, front, back, evidence FROM flashcards WHERE lesson_id = ? ORDER BY position, id').all(lessonId);
  const saved = loadStatements(db, lessonId) ?? new Map();
  const lessonText = lessonTextOf(db, lessonId);
  const groups = listGroups(lessonText);
  const askable = new Set(
    quizCandidates(cards, { lessonText })
      .filter((c) => c.card.kind !== 'term' && !c.problems.some((p) => ['a', 'k', 'l', 'm', 'o'].includes(p.rule)))
      .map((c) => c.card.id),
  );
  const settled = (c) => {
    const row = saved.get(c.id);
    return row?.card_hash === cardHash(c) && !(row.status === 'rejected' && row.why === NOT_IN_REPLY);
  };
  return cards
    .filter((c) => askable.has(c.id) && !wantsLongAnswer(c) && !siblingItems(groups, c.back) && !settled(c))
    .map(({ id, front, back, evidence }) => ({ id, front, back, evidence }));
}

// Saves each card's pair. A card deleted or written again while the call ran (lesson deleted, cards remade, "Regenerate
// this card") is skipped: its pair was made for the old text. `results`: [{ card: { id, front, back }, trueText,
// falseText, status ('pending' or 'rejected'), why }]. -> how many were saved
export function saveStatements(db, results, now) {
  const save = db.prepare(
    "INSERT OR REPLACE INTO quiz_statements (flashcard_id, card_hash, true_text, false_text, status, why, made_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  let made = 0;
  db.transaction(() => {
    for (const { card, trueText = null, falseText = null, status, why = null } of results) {
      const nowCard = db.prepare('SELECT front, back FROM flashcards WHERE id = ?').get(card.id);
      if (nowCard?.front === card.front && nowCard.back === card.back) made += save.run(card.id, cardHash(card), trueText, falseText, status, why, now().toISOString()).changes;
    }
  })();
  return made;
}

// The AI review's verdict on a pair: ok, or flagged with its reason. Only touches the row while it still holds the pair
// the reviewer saw (same card text, same two sentences) and is pending, ok or flagged (a rejected row has no pair).
// -> how many rows changed (0 or 1)
export function markStatementReviewed(db, { cardId, cardHash: hash, trueText, falseText, flagged, why = null, now }) {
  return db
    .prepare(
      `UPDATE quiz_statements SET status = ?, why = ?, reviewed_at = ?
       WHERE flashcard_id = ? AND card_hash = ? AND true_text = ? AND false_text = ? AND status IN ('pending', 'ok', 'flagged')`,
    )
    .run(flagged ? 'flagged' : 'ok', flagged ? why : null, now().toISOString(), cardId, hash, trueText, falseText).changes;
}
