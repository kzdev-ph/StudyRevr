import { getSetting } from '../services/settings.js';
import { DEFAULT_CONFIG } from './scheduler.js';

// Scheduler settings from the `settings` table, each falling back to the Anki default in DEFAULT_CONFIG when the row
// is missing or not a valid value. The first three are user-facing (Settings screen, Phase 7); the rest can be
// changed with their own rows.
const NUMBER_KEYS = {
  newPerDay: ['flashcard_new_per_day', 0, 9999, true],
  reviewsPerDay: ['flashcard_reviews_per_day', 0, 99999, true],
  graduatingInterval: ['flashcard_graduating_interval', 1, 36500, true],
  easyInterval: ['flashcard_easy_interval', 1, 36500, true],
  startingEase: ['flashcard_starting_ease', 1.3, 5, false],
  easyBonus: ['flashcard_easy_bonus', 1, 5, false],
  hardInterval: ['flashcard_hard_interval', 1, 5, false],
  lapseInterval: ['flashcard_lapse_interval', 0, 1, false],
  minInterval: ['flashcard_min_interval', 1, 36500, true],
  maxInterval: ['flashcard_max_interval', 1, 36500, true],
};

export const DEFAULT_FLASHCARDS_MAX = 30;
const FLASHCARDS_MAX_LIMIT = 200;

// "1m 10m" -> [1, 10] (minutes). Units: s, m, h, d; a bare number is minutes. null when it isn't a valid list.
export function parseSteps(text) {
  const tokens = String(text ?? '').trim().split(/[\s,]+/).filter(Boolean);
  const factor = { s: 1 / 60, m: 1, h: 60, d: 1440 };
  const steps = [];
  for (const token of tokens) {
    const m = /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(token);
    if (!m) return null;
    const minutes = Number(m[1]) * factor[(m[2] || 'm').toLowerCase()];
    if (!(minutes > 0) || minutes > 1440 * 365) return null;
    steps.push(minutes);
  }
  return steps;
}

function readNumber(db, [key, min, max, integer]) {
  const raw = getSetting(db, key);
  if (raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) return undefined;
  return n;
}

export function loadSchedulerConfig(db, overrides = {}) {
  const cfg = { ...DEFAULT_CONFIG };
  for (const [field, spec] of Object.entries(NUMBER_KEYS)) cfg[field] = readNumber(db, spec) ?? cfg[field];
  const learning = getSetting(db, 'flashcard_learning_steps');
  if (learning) cfg.learningSteps = parseSteps(learning) ?? cfg.learningSteps;
  const relearning = getSetting(db, 'flashcard_relearning_steps');
  if (relearning) cfg.relearningSteps = parseSteps(relearning) ?? cfg.relearningSteps;
  const zone = getSetting(db, 'study_timezone');
  if (zone && isTimeZone(zone)) cfg.timeZone = zone;
  if (cfg.maxInterval < cfg.minInterval) cfg.maxInterval = cfg.minInterval;
  return { ...cfg, ...overrides };
}

function isTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Cards made per lesson at most (setting `flashcards_max`).
export function flashcardsMax(db) {
  const n = readNumber(db, ['flashcards_max', 1, FLASHCARDS_MAX_LIMIT, true]);
  return n ?? DEFAULT_FLASHCARDS_MAX;
}
