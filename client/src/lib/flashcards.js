// Pure helpers for the Flashcard tab (unit-tested in client/test).

export const RATINGS = [
  { rating: 1, name: 'Again', tone: 'again' },
  { rating: 2, name: 'Hard', tone: 'hard' },
  { rating: 3, name: 'Good', tone: 'good' },
  { rating: 4, name: 'Easy', tone: 'easy' },
];

const MINUTE = 60_000;
const SECONDS_PER_CARD = 10; // a rough average for "about N min"

// Minutes a set of cards takes, at least 1. counts: { new, learning, due }
export const studyMinutes = (counts) => Math.max(1, Math.round(((counts.new + counts.learning + counts.due) * SECONDS_PER_CARD) / 60));

export const totalDue = (counts) => (counts ? counts.new + counts.learning + counts.due : 0);

const sameDay = (a, b, timeZone) => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(a) === fmt.format(b);
};

// When the next card is due, in words: "in 25 minutes", "today at 3:45 PM", "tomorrow at 4:00 AM", "on Fri, Oct 9".
// `timeZone`/`locale` default to the device's (tests pass fixed ones).
export function describeNextDue(iso, now = new Date(), { timeZone, locale } = {}) {
  if (!iso) return null;
  const due = new Date(iso);
  const ms = due.getTime() - now.getTime();
  if (ms <= MINUTE) return 'in a moment';
  if (ms < 60 * MINUTE) {
    const minutes = Math.round(ms / MINUTE);
    return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  const time = due.toLocaleTimeString(locale, { timeZone, hour: 'numeric', minute: '2-digit' });
  if (sameDay(due, now, timeZone)) return `today at ${time}`;
  if (sameDay(due, new Date(now.getTime() + 86_400_000), timeZone)) return `tomorrow at ${time}`;
  return `on ${due.toLocaleDateString(locale, { timeZone, weekday: 'short', month: 'short', day: 'numeric' })}`;
}

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const PRESSABLE = new Set(['BUTTON', 'A', 'SUMMARY']);

// A key press on the study screen -> 'flip' | 'undo' | 1-4 (a rating) | null.
//   Space flips the card; 1-4 answer once the answer shows; Ctrl/Cmd+Z or U undoes the last answer.
// Keys typed into a form field, and other modifier combinations, are left alone. Space on a focused button or link
// is left to the browser (it presses that button), so it never does two things at once.
export function keyAction(event, { revealed }) {
  const target = event.target;
  if (target && (TYPING.has(target.tagName) || target.isContentEditable)) return null;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === 'z') return 'undo';
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === ' ' || event.code === 'Space') return revealed || PRESSABLE.has(target?.tagName) ? null : 'flip';
  if (event.key?.toLowerCase() === 'u') return 'undo';
  if (revealed && /^[1-4]$/.test(event.key ?? '')) return Number(event.key);
  return null;
}

// The three counts in the order they are shown; `queue` is the study queue each one belongs to.
export const COUNTS = [
  { key: 'new', queue: 'new', name: 'new' },
  { key: 'learning', queue: 'learning', name: 'learning' },
  { key: 'due', queue: 'review', name: 'due' },
];

// "3 new, 1 learning, 5 due" for screen readers and summaries; with `current` (the queue of the card on screen)
// it adds which one the card comes from: "... This is a learning card."
export function describeCounts(counts, current) {
  const text = COUNTS.map((c) => `${counts[c.key]} ${c.name}`).join(', ');
  const from = COUNTS.find((c) => c.queue === current);
  if (!from) return text;
  return `${text}. This is ${from.key === 'due' ? 'a due' : `a ${from.name}`} card.`;
}

const UNITS = { m: 'minute', h: 'hour', d: 'day', mo: 'month', y: 'year' };

// A button's interval label ("<1m", "10m", "1.5h", "4d", "2.3mo", "1y") in words, for screen readers.
export function spellInterval(label) {
  if (label === '<1m') return 'less than a minute';
  const m = /^(\d+(?:\.\d+)?)(mo|m|h|d|y)$/.exec(label ?? '');
  if (!m) return label;
  const n = Number(m[1]);
  return `${m[1]} ${UNITS[m[2]]}${n === 1 ? '' : 's'}`;
}
