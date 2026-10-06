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
  if (q.type === 'tf') return 'True or false?';
  return q.kind === 'term' ? 'Which term matches this description?' : 'Choose the best answer';
}

// The whole question in one sentence, for screen readers and the results list.
export function questionText(q) {
  if (q.type !== 'tf') return q.question;
  return q.kind === 'term' ? `${q.question} means: ${q.statement}` : `${q.question} Answer: ${q.statement}`;
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
  if (percentNow > previousBest) return `New best! Your previous best was ${previousBest}%.`;
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
