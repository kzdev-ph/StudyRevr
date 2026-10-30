// Study-session tracking, with no React and no browser globals so it can be tested with a fake clock.
//
// A session is one stretch of active study on a lesson (reading, flashcards or quiz). Only active time counts:
//   - the clock runs while the screen is open, the app is in front, and the student keeps interacting;
//   - IDLE_MS (5 min) without a tap, scroll or key ends the session at the last interaction (the idle minutes are
//     not counted); the next interaction starts a new session;
//   - in the background (another app, screen off) the clock pauses and the time so far is sent at once. Back within
//     IDLE_MS, the same session carries on; after longer, it ended when the app went away ('background') and a new
//     one starts;
//   - closing the screen ends it ('left'); signing out ends it ('signed_out').
// The server is told every HEARTBEAT_MS too, so little is lost if the browser is killed.

export const IDLE_MS = 5 * 60_000;
export const HEARTBEAT_MS = 30_000;

// start()   -> Promise of the new session's id (POST /api/sessions)
// report(id, { active_ms, end_reason?, ended_ago_ms? })   (POST /api/sessions/:id); may return a promise
export function createSessionTracker({ start, report, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, idleMs = IDLE_MS, heartbeatMs = HEARTBEAT_MS, visible = true }) {
  let current = null; // { id: Promise<id|null>, activeMs, since (ms the clock started running, or null) }
  let lastInteraction = now();
  let hiddenAt = visible ? null : now();
  let finishedMs = 0; // active time of the sessions this tracker already ended
  let idleTimer = null;
  let beatTimer = null;
  let closed = false;

  const running = () => current && current.since !== null;
  const activeNow = (until = now()) => (current ? current.activeMs + (running() ? Math.max(0, until - current.since) : 0) : 0);

  // -> a promise that settles once the report has gone out (a sign-out waits for the last one)
  const send = (session, body) => session.id.then((id) => id && report(id, body));

  const stopTimers = () => {
    clearTimer(idleTimer);
    clearTimer(beatTimer);
    idleTimer = beatTimer = null;
  };

  const schedule = () => {
    stopTimers();
    if (!running()) return;
    idleTimer = setTimer(checkIdle, Math.max(0, lastInteraction + idleMs - now()));
    beatTimer = setTimer(beat, heartbeatMs);
  };

  // Heartbeats count only up to the last interaction: if the student has gone idle, those minutes may not count,
  // and the server never lowers a session's time.
  function beat() {
    if (!running()) return;
    send(current, { active_ms: activeNow(lastInteraction) });
    beatTimer = setTimer(beat, heartbeatMs);
  }

  function checkIdle() {
    if (!running()) return;
    const t = now();
    if (t - lastInteraction < idleMs) {
      idleTimer = setTimer(checkIdle, lastInteraction + idleMs - t);
      return;
    }
    // ended at the last interaction: the idle minutes don't count
    end('idle', lastInteraction);
  }

  function begin() {
    if (closed || current) return;
    const t = now();
    const session = { activeMs: 0, since: hiddenAt === null ? t : null, id: null };
    session.id = Promise.resolve()
      .then(start)
      .catch(() => null)
      .then((id) => {
        if (!id && current === session) current = null; // couldn't open: the next interaction tries again
        return id;
      });
    current = session;
    lastInteraction = t;
    schedule();
  }

  // Ends the current session; `at` is when it really ended (the last interaction, or when the app went away).
  function end(reason, at = now()) {
    if (!current) return Promise.resolve();
    const t = now();
    const session = current;
    const active = activeNow(Math.min(at, t));
    current = null;
    stopTimers();
    finishedMs += active;
    return send(session, { active_ms: active, end_reason: reason, ended_ago_ms: Math.max(0, t - at) });
  }

  return {
    // the screen opened
    open: begin,
    // a tap, scroll or key press
    interaction() {
      if (closed || hiddenAt !== null) return;
      if (!current) return begin();
      lastInteraction = now();
    },
    // the app went to the background
    hide() {
      if (closed || hiddenAt !== null) return;
      const t = now();
      hiddenAt = t;
      if (!current) return;
      current.activeMs = activeNow(t);
      current.since = null;
      stopTimers();
      send(current, { active_ms: current.activeMs });
    },
    // the app is in front again
    show() {
      if (closed || hiddenAt === null) return;
      const t = now();
      const away = t - hiddenAt;
      const wentAt = hiddenAt;
      hiddenAt = null;
      if (current && away > idleMs) end('background', wentAt);
      if (!current) return begin();
      current.since = t;
      lastInteraction = t;
      schedule();
    },
    // the screen closed ('left') or the student signed out ('signed_out'). -> a promise of the last report
    close(reason = 'left') {
      if (closed) return Promise.resolve();
      const sent = end(reason, hiddenAt ?? now());
      closed = true;
      return sent;
    },
    // active time of every session this tracker has run, the open one included (the flashcard recap)
    totalActiveMs: () => finishedMs + activeNow(),
    isOpen: () => Boolean(current),
  };
}
