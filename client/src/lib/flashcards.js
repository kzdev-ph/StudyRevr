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
//   `ready`: the answer side has finished turning (default: as soon as it is revealed). 1-4 wait for it, so a rating
//   is never given mid-turn; Space on a revealed card does nothing.
export function keyAction(event, { revealed, ready = revealed }) {
  const target = event.target;
  if (target && (TYPING.has(target.tagName) || target.isContentEditable)) return null;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === 'z') return 'undo';
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === ' ' || event.code === 'Space') return revealed || PRESSABLE.has(target?.tagName) ? null : 'flip';
  if (event.key?.toLowerCase() === 'u') return 'undo';
  if (ready && /^[1-4]$/.test(event.key ?? '')) return Number(event.key);
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

// The done card's recap of this sitting: ratings answered (undone ones removed) and active time.
// -> { cards, timeMs, goodEasyPct (null when nothing was answered) }
export function sessionRecap(ratings, activeMs) {
  const goodEasy = ratings.filter((r) => r >= 3).length;
  return { cards: ratings.length, timeMs: Math.max(0, activeMs), goodEasyPct: ratings.length ? Math.round((goodEasy / ratings.length) * 100) : null };
}

// Where an answered card goes on screen, from the button that was pressed ({ minutes } or { days }, from the
// scheduler's preview): back under the deck when it comes back within the day (Again, a learning step), onto the done
// pile when it waits a day or more. Read before the answer is sent: the next card brings new buttons.
export function comesBackToday(button) {
  if (!button || button.days !== undefined) return false;
  return Number(button.minutes) < 1440;
}

// Ratings (buttons and keys 1-4) are open once the answer is revealed and the card has finished turning: the turn is
// never part of the answer time, and nothing can be rated before its answer is readable.
export const canRate = ({ revealed, turned }) => Boolean(revealed && turned);
