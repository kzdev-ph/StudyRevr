import { loadDistractors } from './distractors.js';
import { usableFamilies } from './related.js';
import { readReview } from './review-flags.js';

// Everything the quiz builder reads for one lesson besides its cards (see quizCandidates in build.js). Used by the quiz
// routes, the admin leak report and `npm run quiz:check`, so all three build the same questions. Works on a database
// from before migration 013 (no reviews, no families): quiz:check opens any StudyRevr database read-only.

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

// Map card id -> readReview(row) for the lesson's reviewed cards.
export function loadReviews(db, lessonId) {
  if (!hasTable(db, 'quiz_reviews')) return new Map();
  const rows = db.prepare('SELECT * FROM quiz_reviews WHERE lesson_id = ?').all(lessonId);
  return new Map(rows.map((r) => [r.flashcard_id, readReview(r)]));
}

// [[term, ...]] the reviewer grouped, or [].
export function loadTermFamilies(db, lessonId) {
  if (!hasColumn(db, 'lessons', 'term_families')) return [];
  const json = db.prepare('SELECT term_families FROM lessons WHERE id = ?').get(lessonId)?.term_families;
  try {
    const families = JSON.parse(json ?? '[]');
    return Array.isArray(families) ? usableFamilies(families.filter(Array.isArray)) : [];
  } catch {
    return [];
  }
}

export function quizBuildOptions(db, lessonId) {
  return {
    distractors: loadDistractors(db, lessonId),
    extraTerms: db.prepare('SELECT term FROM key_terms WHERE lesson_id = ? ORDER BY id').all(lessonId).map((t) => t.term),
    lessonText: db.prepare('SELECT raw_text FROM lessons WHERE id = ?').get(lessonId)?.raw_text ?? '',
    termFamilies: loadTermFamilies(db, lessonId),
    reviews: loadReviews(db, lessonId),
  };
}
