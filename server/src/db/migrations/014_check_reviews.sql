-- The AI exam reviewer's verdict on a section's quick checks (services/check-review.js), next to the checks it covers.
-- JSON { hash, round, flags, dropped, made_by, reviewed_at }, NULL until reviewed:
--   hash     the section text and its quick checks when reviewed: the quiz_review stage reviews a section again only
--            when they change, so a review is cached
--   round    1 = first review; 2 = reviewed again after the flagged checks were written again once
--   flags    [{ question, flag, why }] that were found in the last round (the flagged checks are no longer shown)
--   dropped  [{ question, answer, why }] the checks taken out of check_questions by the review
-- Shared like the sections, never exported.
ALTER TABLE sections ADD COLUMN check_review TEXT;
