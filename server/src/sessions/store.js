import { HttpError } from '../middleware/errors.js';
import { studyDate } from '../stats/days.js';

// Study sessions (see migration 008). The app opens one when a participant opens Review, Flashcards or the Mock Quiz
// on a lesson, reports its active time every 30 s and when it goes to the background, and closes it when the screen
// closes, after 5 minutes without interaction, or after more than 5 minutes in the background. The server only
// stores what it is told, with two checks: active time never shrinks, and never exceeds the time since the start.

export const ACTIVITIES = ['reading', 'flashcards', 'quiz'];
// What the app may send as an end reason ('switched' stays in the column's CHECK for old rows only).
export const END_REASONS = ['left', 'idle', 'background', 'signed_out'];
// Only the server ends a session for these (another device signed in, or the admin signed the student out).
export const SERVER_END_REASONS = ['signed_out_elsewhere', 'signed_out_by_admin'];
// A session the app stopped reporting (tab killed, phone off) counts as ended at its last report after this long.
export const STALE_MS = 5 * 60_000;

const COLUMNS = 'id, participant_id, lesson_id, activity, started_at, last_active_at, ended_at, active_ms, end_reason, study_date';

export function getSession(db, id, participantId) {
  const row = db.prepare(`SELECT ${COLUMNS} FROM study_sessions WHERE id = ?`).get(id);
  if (!row || row.participant_id !== participantId) throw new HttpError(404, 'Study session not found.');
  return row;
}

// What a student is sent: the row without participant_id (it would give away the P-code). Server code keeps the full row.
export function publicSession({ participant_id: _owner, ...session }) {
  return session;
}

export function startSession(db, { participantId, lessonId = null, activity, now, config }) {
  if (lessonId !== null && !db.prepare('SELECT 1 FROM lessons WHERE id = ?').get(lessonId)) throw new HttpError(404, 'Lesson not found.');
  const at = now.toISOString();
  const id = Number(
    db
      .prepare(
        `INSERT INTO study_sessions (participant_id, lesson_id, activity, started_at, last_active_at, active_ms, study_date)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(participantId, lessonId, activity, at, at, studyDate(now, config)).lastInsertRowid,
  );
  return getSession(db, id, participantId);
}

// A heartbeat (active_ms so far) and, with `endReason`, the end. `endedAgoMs` places the end before now (an idle
// session ended at the last interaction, 5 minutes ago), never before the start. A report on a session that is
// already closed changes nothing (a late heartbeat can cross the close on a slow network).
export function updateSession(db, { id, participantId, activeMs, endReason = null, endedAgoMs = 0, now }) {
  return db.transaction(() => {
    const s = getSession(db, id, participantId);
    if (s.ended_at) return s;
    const started = Date.parse(s.started_at);
    const wall = Math.max(0, now.getTime() - started);
    const active = Math.max(s.active_ms, Math.min(Math.round(activeMs), wall));
    let endedAt = null;
    if (endReason) {
      const end = Math.max(now.getTime() - Math.max(0, endedAgoMs), started);
      endedAt = new Date(Math.min(end, now.getTime())).toISOString();
    }
    db.prepare('UPDATE study_sessions SET active_ms = ?, last_active_at = ?, ended_at = ?, end_reason = ? WHERE id = ?').run(
      endedAt ? Math.min(active, Date.parse(endedAt) - started) : active,
      endedAt ?? now.toISOString(),
      endedAt,
      endReason,
      id,
    );
    return getSession(db, id, participantId);
  })();
}

// Closes a participant's open sessions at their last report, for a sign-out the app could not report itself. Sessions
// older than STALE_MS stay open and keep reading as 'unclosed'.
export function endOpenSessions(db, { participantId, reason, now }) {
  const cutoff = new Date(now.getTime() - STALE_MS).toISOString();
  return db
    .prepare('UPDATE study_sessions SET ended_at = last_active_at, end_reason = ? WHERE participant_id = ? AND ended_at IS NULL AND last_active_at >= ?')
    .run(reason, participantId, cutoff).changes;
}

// How a session reads in stats and the export: open and still reporting, closed, or 'unclosed' (no report for
// STALE_MS: it ended at its last report).
export function sessionStatus(s, now) {
  if (s.ended_at) return { ended_at: s.ended_at, end_reason: s.end_reason };
  if (now.getTime() - Date.parse(s.last_active_at) > STALE_MS) return { ended_at: s.last_active_at, end_reason: 'unclosed' };
  return { ended_at: null, end_reason: 'open' };
}
