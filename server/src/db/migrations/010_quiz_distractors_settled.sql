-- Quiz wrong answers that can't be made clean. settled = 1: the AI was asked again once (the follow-up call) and the
-- set still gives the right answer away, so the card is asked as Yes/No (or left out) and is not sent to the AI again
-- by "Remake quiz answers" or a lesson retry. Regenerating the card deletes the row, so a new card starts over.
ALTER TABLE quiz_distractors ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
