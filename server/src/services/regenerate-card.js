import { z } from 'zod';
import { regenerateCardPrompt } from '../ai/prompts.js';
import { HttpError } from '../middleware/errors.js';
import { getJobStatus } from '../pipeline/jobs.js';
import { checkEvidence, comparable } from '../pipeline/evidence.js';
import { MAX_ANSWER_WORDS, MAX_QUESTION_WORDS, shortDefinition } from '../pipeline/flashcards.js';
import { cardLeaks } from '../quiz/leaks.js';
import { hasRecords, participantRecords } from './lesson-records.js';

// Admin "Regenerate this card": one AI call writes a flashcard again when it gives its answer away (quiz/leaks.js).
// Only while no participant other than P00 has records on the lesson (their answers would no longer match the card)
// and no job is running on it; both are checked again when the new card is saved.
// The card is updated in place (same id, so earlier quiz_answers rows still point to it; P00's schedule is kept) and
// its saved quiz wrong answers are deleted, to be made again by admin's "Make quiz answers".

const conceptReply = z.object({ question: z.string().min(1), answer: z.string().min(1), evidence: z.string().catch('') });
const termReply = z.object({ definition: z.string().min(1) });
const LEAK_RULES = ['g', 'h', 'i', 'j', 'k'];
const CONTEXT_CHARS = 12000;
const wordCount = (s) => (String(s).match(/\S+/g) ?? []).length;

// The lesson block that holds the evidence quote with one block on each side, or the start of the lesson.
function contextFor(rawText, evidence) {
  const blocks = String(rawText ?? '').split(/\n\s*\n/);
  const key = comparable(evidence ?? '');
  const at = key ? blocks.findIndex((b) => comparable(b).includes(key)) : -1;
  const text = at < 0 ? rawText : blocks.slice(Math.max(0, at - 1), at + 2).join('\n\n');
  return String(text ?? '').slice(0, CONTEXT_CHARS);
}

const refuse = (message) => new HttpError(422, `${message} Try Regenerate again, or leave the card as it is.`, { code: 'card_not_better' });

// Why a lesson's cards can't be regenerated now, or null: still processing, a job running on it (quiz answers,
// Prepare, making cards: it would save work for the old card), or participants' records.
export function regenerateBlock(db, lessonId) {
  const { lesson, job } = getJobStatus(db, lessonId);
  if (lesson.status !== 'ready') return new HttpError(409, 'Cards can be regenerated once the lesson has finished processing.', { code: 'lesson_busy' });
  if (job && ['queued', 'running'].includes(job.status)) return new HttpError(409, 'This lesson is being worked on. Regenerate its cards once that finishes.', { code: 'lesson_busy' });
  const records = participantRecords(db, lessonId);
  if (hasRecords(records))
    return new HttpError(409, 'Participants have studied this lesson, so its cards can’t change: their answers would no longer match the card.', { code: 'lesson_has_records', records });
  return null;
}

// -> the updated card { id, kind, front, back, evidence, rules } (rules: what still breaks a leak rule, none)
export async function regenerateCard({ db, ai, cardId, log = console }) {
  const card = db.prepare('SELECT id, lesson_id, kind, front, back, evidence FROM flashcards WHERE id = ?').get(cardId);
  if (!card) throw new HttpError(404, 'Flashcard not found.');
  const lesson = db.prepare('SELECT id, status, raw_text FROM lessons WHERE id = ?').get(card.lesson_id);
  const blocked = regenerateBlock(db, lesson.id);
  if (blocked) throw blocked;

  const others = db.prepare('SELECT id, kind, front, back FROM flashcards WHERE lesson_id = ? AND id <> ?').all(lesson.id, card.id);
  const problems = cardLeaks(card, others).map((p) => p.detail);
  const term = card.kind === 'term';
  const { system, user } = regenerateCardPrompt({ card, problems, text: contextFor(lesson.raw_text, card.evidence), others: term ? [] : others.map((o) => o.back) });
  const reply = await ai.generateJSON({ system, user, schema: term ? termReply : conceptReply, maxTokens: 1000, label: 'the new flashcard' });

  let next;
  if (term) {
    const back = shortDefinition(reply.definition.trim());
    if (wordCount(back) > MAX_ANSWER_WORDS) throw refuse('The new definition was too long to recall.');
    next = { ...card, back };
  } else {
    if (wordCount(reply.answer) > MAX_ANSWER_WORDS) throw refuse('The new answer was too long to recall.');
    if (wordCount(reply.question) > MAX_QUESTION_WORDS) throw refuse('The new question was too long.');
    const check = checkEvidence({ term: reply.question, evidence: reply.evidence, sourceKey: comparable(lesson.raw_text) });
    if (!check.ok) throw refuse(`The new card's quote from the lesson didn't check out (${check.reason}).`);
    next = { ...card, front: reply.question.trim(), back: reply.answer.trim(), evidence: check.evidence };
  }
  const leaks = cardLeaks(next, others).filter((p) => LEAK_RULES.includes(p.rule));
  if (leaks.length) throw refuse(`The new card still gives its answer away (${leaks.map((p) => `${p.rule}: ${p.detail}`).join('; ')}).`);

  // checked again where it is saved: the AI call can take a minute, and meanwhile a participant may have started, a
  // job may have been queued, or the card may have been written again from another tab
  db.transaction(() => {
    const late = regenerateBlock(db, lesson.id);
    if (late) throw late;
    const current = db.prepare('SELECT front, back FROM flashcards WHERE id = ?').get(card.id);
    if (current?.front !== card.front || current.back !== card.back) throw new HttpError(409, 'This card changed while it was being written. Look at it again before regenerating.', { code: 'card_changed' });
    db.prepare('UPDATE flashcards SET front = ?, back = ?, evidence = ? WHERE id = ?').run(next.front, next.back, next.evidence, card.id);
    db.prepare('DELETE FROM quiz_distractors WHERE flashcard_id = ?').run(card.id);
  })();
  log.info?.(`[admin] lesson ${lesson.id}: card ${card.id} regenerated ("${card.front}" -> "${next.front}")`);
  return { id: card.id, kind: card.kind, front: next.front, back: next.back, evidence: next.evidence, rules: [] };
}
