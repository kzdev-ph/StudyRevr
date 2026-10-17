import { z } from 'zod';
import { studyDate } from '../stats/days.js';

// Settings a participant changed, logged in setting_events (migration 011). One zod schema per setting, so another
// setting is one more entry here.
export const SETTING_VALUES = {
  motion: ['system', 'less', 'full'], // Match my device | Less motion | Full motion
  theme: ['system', 'light', 'dark', 'ama', 'ama-dark'], // Match my device | Light | Dark | AMA | AMA Dark
};

export const settingEventBody = z.discriminatedUnion(
  'setting',
  Object.entries(SETTING_VALUES).map(([setting, values]) => z.object({ setting: z.literal(setting), value: z.enum(values) })),
);

export function logSettingEvent(db, { participantId, setting, value, now, config }) {
  return Number(
    db
      .prepare('INSERT INTO setting_events (participant_id, study_date, setting, value, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(participantId, studyDate(now, config), setting, value, now.toISOString()).lastInsertRowid,
  );
}
