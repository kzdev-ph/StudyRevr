// Pure helpers for the Stats tab (unit-tested in client/test).

export const ACTIVITIES = [
  { key: 'reading', label: 'Reading', color: 'var(--series-reading)' },
  { key: 'flashcards', label: 'Flashcards', color: 'var(--series-flashcards)' },
  { key: 'quiz', label: 'Quiz', color: 'var(--series-quiz)' },
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Study time in words: "0 min", "12 min", "1 h 5 min". Rounded to the minute (under a minute shows "<1 min").
export function studyTime(ms) {
  const minutes = Math.round((Number(ms) || 0) / 60_000);
  if (minutes === 0) return ms > 0 ? '<1 min' : '0 min';
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}

// 'YYYY-MM-DD' (a study day) -> 'Mon'
export const weekday = (date) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

// The week chart's rows: one per day, minutes per activity (one decimal), with the day's total.
export function weekRows(days) {
  return days.map((d) => {
    const row = { date: d.date, day: weekday(d.date) };
    for (const { key } of ACTIVITIES) row[key] = Math.round(((d[`${key}_ms`] ?? 0) / 60_000) * 10) / 10;
    row.total = Math.round((row.reading + row.flashcards + row.quiz) * 10) / 10;
    return row;
  });
}

// "Most active day: Tuesday (35 min)." for the week's study days ({ date, reading_ms, flashcards_ms, quiz_ms }); null
// when there was no study time. A tie goes to the earlier day.
export function mostActiveDay(days) {
  const total = (d) => ACTIVITIES.reduce((sum, { key }) => sum + (d[`${key}_ms`] ?? 0), 0);
  const best = days.reduce((top, d) => (total(d) > (top ? total(top) : 0) ? d : top), null);
  if (!best) return null;
  return `Most active day: ${WEEKDAY_NAMES[new Date(`${best.date}T00:00:00Z`).getUTCDay()]} (${studyTime(total(best))}).`;
}

export const pct = (value) => (value === null || value === undefined ? '–' : `${Math.round(value)}%`);

// "84 cards, 76% Good or Easy" / "No cards yet"
export function cardsLine({ reviewed, good_easy_pct: goodEasy }) {
  if (!reviewed) return 'No cards answered yet';
  return `${reviewed} ${reviewed === 1 ? 'card' : 'cards'}, ${pct(goodEasy)} Good or Easy`;
}
