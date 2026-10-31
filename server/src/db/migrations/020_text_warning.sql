-- Why an upload's text may be poor (feat/accounts): the code the upload put on the lesson, one of 'scanned_pdf' (a PDF
-- with little or no text layer), 'damaged_text' (a text layer with letters missing) or 'short_text' (under 150 words).
-- NULL means nothing was found, the lesson is older than this column, or it was made by a script or an import. No CHECK:
-- the messages live in services/lesson-access.js (TEXT_WARNINGS) and a code it does not know is shown as no warning.
ALTER TABLE lessons ADD COLUMN text_warning TEXT;
