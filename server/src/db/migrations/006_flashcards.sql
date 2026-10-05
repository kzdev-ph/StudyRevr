-- Phase 4: flashcards. The tables come from 001; this adds what generation, grounding and the review log need.
--   flashcards.kind       'term' (term -> definition, seeded from key_terms) | 'concept' (question -> answer)
--   flashcards.evidence   the verbatim lesson quote the card was checked against ("From the lesson: ...")
--   flashcards.position   introduction order of new cards within a lesson
-- Intervals are in days; a learning step is stored as a fraction of a day (10 min = 10/1440).
ALTER TABLE flashcards ADD COLUMN kind TEXT NOT NULL DEFAULT 'concept';
ALTER TABLE flashcards ADD COLUMN evidence TEXT;
ALTER TABLE flashcards ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_flashcards_lesson_position ON flashcards(lesson_id, position);

-- One row per answer (rating = button: 1 Again, 2 Hard, 3 Good, 4 Easy). Stats (Phase 6) reads it.
--   state     the card's state before the answer (0 new, 1 learning, 2 review, 3 relearning); daily limits count it
--   ease      the ease factor after the answer
--   time_ms   how long the student looked at the card before answering
--   snapshot  the card's scheduling fields before the answer (JSON), so the answer can be undone exactly
ALTER TABLE flashcard_reviews ADD COLUMN state INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flashcard_reviews ADD COLUMN ease REAL NOT NULL DEFAULT 0;
ALTER TABLE flashcard_reviews ADD COLUMN time_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flashcard_reviews ADD COLUMN snapshot TEXT;

-- The user-facing flashcard settings (the Settings screen arrives in Phase 7). Other scheduler values have code
-- defaults and can be overridden with their own rows (see server/src/flashcards/config.js).
INSERT OR IGNORE INTO settings (key, value) VALUES ('flashcard_new_per_day', '20');
INSERT OR IGNORE INTO settings (key, value) VALUES ('flashcard_reviews_per_day', '200');
INSERT OR IGNORE INTO settings (key, value) VALUES ('flashcard_learning_steps', '1m 10m');
INSERT OR IGNORE INTO settings (key, value) VALUES ('flashcards_max', '30');
