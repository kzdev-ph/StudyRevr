import { DEFAULT_CONFIG, studyDay } from '../flashcards/scheduler.js';

// Study days for logging and stats, on the same boundary as flashcards: a day starts at 04:00 Asia/Manila (the
// scheduler config's dayStartHour / timeZone), so 01:00 on Tuesday still counts as Monday.

const DAY = 86_400_000;

const localDate = (instant, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);

// The study day `date` falls in, as 'YYYY-MM-DD' (its local calendar date).
export function studyDate(date, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return localDate(studyDay(new Date(date), cfg).start, cfg.timeZone);
}

// Whole study days from one 'YYYY-MM-DD' to another (b - a).
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

// The study week `now` falls in: Monday 04:00 to the next Monday 04:00. -> { start, end, dates: ['YYYY-MM-DD' x7] }
export function studyWeek(now, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const today = studyDay(now, cfg).start;
  const weekday = new Date(`${localDate(today, cfg.timeZone)}T00:00:00Z`).getUTCDay(); // 0 Sunday
  const back = (weekday + 6) % 7; // days since Monday
  const start = studyDay(new Date(today.getTime() - back * DAY + DAY / 2), cfg).start;
  const end = studyDay(new Date(start.getTime() + 7 * DAY + DAY / 2), cfg).start;
  const dates = Array.from({ length: 7 }, (_, i) => studyDate(new Date(start.getTime() + i * DAY + DAY / 2), cfg));
  return { start, end, dates };
}

// The study day after the one `now` falls in. -> { start, end }
export function nextStudyDay(now, config = DEFAULT_CONFIG) {
  const { end } = studyDay(now, config);
  return studyDay(new Date(end.getTime() + DAY / 2), config);
}
