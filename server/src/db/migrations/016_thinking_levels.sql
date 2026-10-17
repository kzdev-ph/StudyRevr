-- Thinking-level experiment (feat/thinking-test): "Think harder when preparing lessons" has four levels.

-- Admin setting: 'minimal' (nothing sent: the old 'off') | 'low' | 'medium' | 'high' (reasoning_effort on lesson
-- processing calls only; Explain simpler and Filipino/Taglish never think). Low became the default after a blind
-- graded run of three lessons at Minimal / Low / Medium; an install still on the old default 'off' moves to it.
UPDATE settings SET value = 'low' WHERE key = 'lesson_thinking' AND value = 'off';
INSERT OR IGNORE INTO settings (key, value) VALUES ('lesson_thinking', 'low');

-- What a lesson was prepared with. processed_thinking (015) only allows off / high / mixed and a CHECK can't be widened
-- without rebuilding lessons (which would cascade-delete its children), so the level moves to a new column and
-- processed_thinking is no longer written.
--   NULL     made before the setting existed (no thinking was sent) or still processing
--   minimal | low | medium | high   every processing call asked for that level
--   mixed    a retry finished a lesson that an earlier run began at another level
ALTER TABLE lessons ADD COLUMN thinking_level TEXT;
UPDATE lessons SET thinking_level = CASE processed_thinking WHEN 'off' THEN 'minimal' WHEN 'high' THEN 'high' WHEN 'mixed' THEN 'mixed' END;
