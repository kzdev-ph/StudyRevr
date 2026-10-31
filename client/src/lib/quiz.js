// Pure helpers for the Mock Quiz tab (unit-tested in client/test).

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const PRESSABLE = new Set(['BUTTON', 'A', 'SUMMARY']);

// A key press on the quiz screen -> an option index (0-based) | 'next' | null.
//   1-4 answer while a question is open (1-2 on true / false); Enter goes on once the answer shows.
// Keys typed into a form field and modifier combinations are left alone. Enter on a focused button or link is left to
// the browser (it presses that button), so it never does two things at once.
export function quizKeyAction(event, { phase, optionCount = 0 }) {
  const target = event.target;
  if (target && (TYPING.has(target.tagName) || target.isContentEditable)) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (phase === 'question' && /^[1-9]$/.test(event.key ?? '')) {
    const n = Number(event.key);
    return n <= optionCount ? n - 1 : null;
  }
  if (phase === 'feedback' && event.key === 'Enter') return PRESSABLE.has(target?.tagName) ? null : 'next';
  return null;
}

// The small line above a question, telling the student what kind of question it is.
export function questionLead(q) {
  if (q.type === 'tf') return 'True or False';
  return q.kind === 'term' ? 'Which term matches this description?' : 'Choose the best answer';
}

// A display-only capital for the first letter of a sentence or option (the stored text is never changed). A word whose
// second letter is a capital ("iPhone", "pH") is left as it is.
export const capitalFirst = (text) => String(text ?? '').replace(/^(\s*["“'(]?)(\p{Ll})(?!\p{Lu})/u, (_, lead, letter) => lead + letter.toUpperCase());

// Words after which a sentence's capital is only there because it starts the sentence ("The sample..." -> "the sample...").
const OPENERS = new Set(
  'A An The It Its This That These Those Any Each Every One Some To When How What Which Who Where In On For By With From Ang Mga Isang Ito'.split(' '),
);

// A display-only lower-case first letter, for a definition that continues a sentence ("Sampling means picking part...").
// Only a common opener or a capitalised -ing word is lowered; names, acronyms and "pH" are left alone.
export function lowerFirst(text) {
  const s = String(text ?? '');
  const m = /^(\s*["“'(]?)(\p{Lu}\p{L}*)/u.exec(s);
  if (!m) return s;
  const word = m[2];
  if (!OPENERS.has(word) && !/^\p{Lu}\p{Ll}+ing$/u.test(word)) return s;
  return m[1] + word[0].toLowerCase() + s.slice(m[1].length + 1);
}

// Ends a sentence with a full stop unless it already ends in . ! or ? (a closing quote or bracket may follow).
const endSentence = (s) => (/[.!?]["”’')]*$/.test(String(s ?? '').trim()) ? String(s ?? '').trim() : `${String(s ?? '').trim()}.`);

// A true / false question is shown as "True or False", then "Question:" and one statement, then True / False; the
// server stores and exports True / False (choices, chosen_answer, right_answer).
//   term:    "<term> means <definition>."
//   concept: "<the card's question> <the suggested answer>."
//   statement (an AI sentence pair): the whole sentence alone.
export function tfStatement(q) {
  if (q.form === 'statement') return capitalFirst(endSentence(q.statement));
  if (q.kind === 'term') return `${q.question} means ${lowerFirst(endSentence(q.statement))}`;
  return `${endSentence(q.question)} ${capitalFirst(endSentence(q.statement))}`;
}

// What a missed or answered-wrong True / False statement should have said: the card's own answer, once, as a plain
// sentence, never as a "right answer" (the right answer of a true / false item is True or False). '' when the answer is
// not known. A statement that was true and answered False is told so: "That statement is true."
//   term:    "<term> means <definition>."
//   concept: "The answer is <the suggested answer>."
//   statement: "The true statement: <the true sentence>."
export function tfCorrection(q) {
  if (q.type !== 'tf') return '';
  if (q.right_answer === 'True') return 'That statement is true.';
  const answer = String(q.answer_text ?? '').trim();
  if (!answer) return '';
  if (q.form === 'statement') return `The true statement: ${capitalFirst(endSentence(answer))}`;
  if (q.kind === 'term') return `${q.question} means ${lowerFirst(endSentence(answer))}`;
  return `The answer is ${endSentence(answer)}`;
}

// The whole question as one text, for the results list.
export function questionText(q) {
  return q.type === 'tf' ? tfStatement(q) : q.question;
}

export const percent = (score, total) => (total ? Math.round((score / total) * 100) : 0);

// "8 of 10 right"
export const scoreLine = (score, total) => `${score} of ${total} right`;

// 45000 -> "45 s", 125000 -> "2 min 5 s", 3600000 -> "60 min"
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

// What the results screen says about the best score. `previousBest`: the best percent before this attempt (null if
// this is the first finished one).
export function bestLine(percentNow, previousBest) {
  if (previousBest === null || previousBest === undefined) return 'Your first score on this lesson.';
  if (percentNow > previousBest) return `New best. Your previous best was ${previousBest}%.`;
  return `Your best on this lesson: ${previousBest}%.`;
}

// A lesson row on the Mock Quiz tab: what is shown under its title.
export function lessonQuizLine(row) {
  if (!row.attempts) return row.questions ? `${row.questions} ${row.questions === 1 ? 'question' : 'questions'} · not taken yet` : '';
  const { score, total, percent: p } = row.best;
  return `Best ${score}/${total} (${p}%) · ${row.attempts} ${row.attempts === 1 ? 'attempt' : 'attempts'}`;
}

// Milliseconds a timer has run, from `startedAt` (performance.now() style) to `now`, never negative.
export const elapsed = (startedAt, now) => Math.max(0, Math.round(now - startedAt));

// The answer sheet at the top of a quiz: one bubble per question, 'done' (answered), 'now' (open) or 'todo'.
// `answered`: how many questions have an answer; `index`: the question on screen.
export function bubbleStates(total, answered, index) {
  return Array.from({ length: Math.max(0, total) }, (_, k) => (k < answered ? 'done' : k === index ? 'now' : 'todo'));
}
