-- Who wrote a lesson's generated content (feat/claude-import): 'gemini' is the admin Default AI (the pipeline, whatever
-- provider is set; every lesson made before this column too), 'claude-haiku' a lesson written offline by Claude Code
-- and imported with `npm run lesson:import` through the same checks. `lesson:rebuild` sets it back to 'gemini'.
ALTER TABLE lessons ADD COLUMN made_by TEXT NOT NULL DEFAULT 'gemini';
