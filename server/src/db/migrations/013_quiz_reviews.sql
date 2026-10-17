-- The AI exam reviewer's verdict on each card's quiz forms (services/quiz-review.js, quiz/review-flags.js). One row per
-- flashcard, made by the pipeline's quiz_review stage or admin's "Review again"; the quiz builder leaves out what it
-- flags. Shared like the cards (not per participant), never exported.
--   card_hash    the card's front and back when reviewed: a card written again (Regenerate) no longer matches, so its
--                old verdict is ignored
--   item_hash    everything the reviewer was shown (question, answer, true statement, options): the stage reviews a
--                card again only when this changes, so a review is cached
--   card_flags   [{ flag, why }] about the card itself: card_reveals | not_in_lesson | vague (the card is not asked)
--   set_flags    [{ flag, why }] about the multiple-choice set: giveaway (not asked as multiple choice)
--   true_flags   [{ flag, why }] about the right answer as a Yes/No statement: giveaway | not_in_lesson (not asked as
--                Yes/No)
--   option_flags { "option text": [{ flag, why }] }: two_correct | reversed | off_topic | giveaway (that option is not
--                shown)
--   round        1 = first review; 2 = reviewed again after the flagged parts were made again once. Whatever is still
--                flagged then stays left out (settled) until admin's "Review again".
--   made_by      provider/model of the admin Default that reviewed it
CREATE TABLE quiz_reviews (
  flashcard_id  INTEGER PRIMARY KEY REFERENCES flashcards(id) ON DELETE CASCADE,
  lesson_id     INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  card_hash     TEXT    NOT NULL,
  item_hash     TEXT    NOT NULL,
  card_flags    TEXT    NOT NULL DEFAULT '[]',
  set_flags     TEXT    NOT NULL DEFAULT '[]',
  true_flags    TEXT    NOT NULL DEFAULT '[]',
  option_flags  TEXT    NOT NULL DEFAULT '{}',
  round         INTEGER NOT NULL DEFAULT 1,
  made_by       TEXT,
  reviewed_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_quiz_reviews_lesson ON quiz_reviews(lesson_id);

-- Key terms the reviewer says belong to one family (kinds of one thing whose definitions overlap), as JSON
-- [["term", "term"], ...]. The quiz never uses one as a wrong option or false statement for another (quiz/related.js).
ALTER TABLE lessons ADD COLUMN term_families TEXT;
