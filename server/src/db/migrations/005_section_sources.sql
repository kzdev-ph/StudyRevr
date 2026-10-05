-- Where a review section came from. The numbers are the real slide / page numbers of the uploaded file (for a Word
-- file, the paragraph number): a slide or page with no text is skipped in raw_text, so a block's place in raw_text is
-- not its slide number.
--   lessons.source_kind     'slide' | 'page' | 'paragraph'
--   lessons.source_numbers  JSON array: the number of each block of raw_text, in order
--   lessons.source_total    how many slides / pages / paragraphs the file really has
--   sections.sources        JSON array of the numbers the section was written from, checked in code against the
--                           lesson's real count. NULL on lessons made before this migration (the app then falls
--                           back to an approximate match).
ALTER TABLE lessons ADD COLUMN source_kind TEXT;
ALTER TABLE lessons ADD COLUMN source_numbers TEXT;
ALTER TABLE lessons ADD COLUMN source_total INTEGER;
ALTER TABLE sections ADD COLUMN sources TEXT;
