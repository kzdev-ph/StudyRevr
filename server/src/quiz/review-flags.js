import { createHash } from 'node:crypto';

// What the AI exam reviewer (services/quiz-review.js) can say about a quiz item, and how the quiz builder reads it.
// Pure: no database or AI here.
//
//   card            the card itself can't be asked:
//     card_reveals    the question gives its own answer away
//     not_in_lesson   the right answer says something the lesson doesn't
//     vague           the question doesn't name its topic ("your presentation"), so it has no single answer
//   set             the multiple-choice set as a whole:
//     giveaway        the right option can be picked without the lesson (it stands out)
//   true_statement  the right answer shown as a Yes/No statement:
//     giveaway        plainly true to anyone (so Yes/No is a free point)
//   options         one wrong option or Yes/No false statement:
//     two_correct     it is also right according to the lesson (or overlaps what the lesson says)
//     reversed        it is the right answer turned around or negated, ruled out at a glance
//     off_topic       it is about something else, or about nothing in the lesson
//     giveaway        it is a silly caricature nobody would pick
export const CARD_FLAGS = ['card_reveals', 'not_in_lesson', 'vague'];
export const SET_FLAGS = ['giveaway'];
export const TRUE_FLAGS = ['giveaway', 'not_in_lesson'];
export const OPTION_FLAGS = ['two_correct', 'reversed', 'off_topic', 'giveaway'];
export const ALL_FLAGS = [...new Set([...CARD_FLAGS, ...SET_FLAGS, ...TRUE_FLAGS, ...OPTION_FLAGS])];

const plain = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const sha = (s) => createHash('sha1').update(s).digest('hex');

// A review belongs to the card's text: one written again (Regenerate) is a different card.
export const cardHash = (card) => sha(`${plain(card.front)}\u0000${plain(card.back)}`);

// Everything one review looked at; a review whose hash no longer matches is reviewed again (cached otherwise).
export const itemHash = (item) => sha(JSON.stringify([plain(item.question), plain(item.answer), plain(item.true_statement), [...item.options].map(plain).sort()]));

// A saved review row -> what the builder needs. flags: [{ flag, why }] lists; options: Map(plain text -> [{ flag, why }])
export function readReview(row) {
  const parse = (json, fallback) => {
    try {
      return JSON.parse(json) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const options = parse(row.option_flags, {});
  return {
    cardHash: row.card_hash,
    card: parse(row.card_flags, []),
    set: parse(row.set_flags, []),
    trueStatement: parse(row.true_flags, []),
    options: new Map(Object.entries(options).map(([text, flags]) => [plain(text), flags])),
    round: row.round,
  };
}

// The review of `card`, or null when there is none for its current text.
export function reviewFor(reviews, card) {
  const review = reviews?.get(card.id);
  return review && review.cardHash === cardHash(card) ? review : null;
}

export const optionFlags = (review, text) => review?.options.get(plain(text)) ?? [];

export const describe = (flags) => flags.map((f) => (f.why ? `${f.flag} (${f.why})` : f.flag)).join('; ');
