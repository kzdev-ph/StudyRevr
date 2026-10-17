-- Content quality round 2: "Think harder when preparing lessons".

-- Admin setting: 'off' (nothing sent: the model's own default) | 'high' (reasoning_effort "high" on lesson processing
-- calls only; Explain simpler and Filipino/Taglish never think).
INSERT OR IGNORE INTO settings (key, value) VALUES ('lesson_thinking', 'off');

-- What a lesson was prepared with, for the methods section.
--   NULL    made before this setting existed (no thinking was sent) or still processing
--   off     every processing call went without thinking
--   high    every processing call asked for high thinking
--   mixed   a retry finished a lesson that an earlier run began under the other level
ALTER TABLE lessons ADD COLUMN processed_thinking TEXT CHECK (processed_thinking IN ('off', 'high', 'mixed'));

-- Live rewrites never think: every row says so, so the export can show it.
ALTER TABLE ai_calls ADD COLUMN thinking TEXT NOT NULL DEFAULT 'off';
