import { getAdminPin, lockAdmin } from './admin.js';
import { getParticipant, setParticipant } from './participant.js';

export class ApiError extends Error {
  constructor(message, status = 0, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const UNREACHABLE = "Can't reach the StudyRevr server. Make sure it is running, then try again.";

// Every request says which participant is studying (X-Participant) and, once admin is unlocked, carries the PIN.
// `as` sends a given participant code instead of the current one (a session's last report after Switch participant).
function headersFor(body, { admin = false, as = null } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const code = as ?? getParticipant();
  if (code) headers['x-participant'] = code;
  const pin = admin ? getAdminPin() : null;
  if (pin) headers['x-admin-pin'] = pin;
  return headers;
}

// What the server's 401s mean for the app: an unknown or missing code goes back to the code screen; a refused PIN
// locks admin again.
function onRefused(code) {
  if (code === 'participant_unknown' || code === 'participant_required') setParticipant(null);
  if (code === 'admin_pin') lockAdmin();
}

async function request(path, { method = 'GET', body, form, signal, admin = false, keepalive = false, as = null } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal,
      keepalive,
      headers: headersFor(form ? undefined : body, { admin, as }),
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(UNREACHABLE);
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.error?.message;
    // The dev proxy answers 500/502/503/504 with no JSON body when the Express server is down.
    if (!message && res.status >= 500) throw new ApiError(UNREACHABLE, res.status);
    if (res.status === 401 && !as) onRefused(data?.error?.code);
    throw new ApiError(message ?? `The server answered with an error (${res.status}).`, res.status, data?.error?.code ?? null);
  }
  return data;
}

// A file from an admin export: fetched with the PIN header (a plain link can't send it), then saved via a blob link.
async function download(path, filename) {
  let res;
  try {
    res = await fetch(`/api${path}`, { headers: headersFor(undefined, { admin: true }) });
  } catch {
    throw new ApiError(UNREACHABLE);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    if (res.status === 401) onRefused(data?.error?.code);
    throw new ApiError(data?.error?.message ?? `The server answered with an error (${res.status}).`, res.status);
  }
  const url = URL.createObjectURL(await res.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Fire-and-forget logging: never interrupts studying, and still goes out when the page is closing (keepalive).
const quietly = (promise) => promise.catch(() => null);

export const api = {
  listLessons: (signal) => request('/lessons', { signal }),
  getLesson: (id, signal) => request(`/lessons/${id}`, { signal }),
  getStatus: (id, signal) => request(`/lessons/${id}/status`, { signal }),
  // admin only: upload, retry, delete, make cards
  uploadLesson: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/lessons', { method: 'POST', form, admin: true });
  },
  retryLesson: (id) => request(`/lessons/${id}/retry`, { method: 'POST', admin: true }),
  deleteLesson: (id) => request(`/lessons/${id}`, { method: 'DELETE', admin: true }),
  simplifySection: (id) => request(`/sections/${id}/simplify`, { method: 'POST' }),
  translateSection: (id) => request(`/sections/${id}/translate`, { method: 'POST' }),
  saveProgress: (id, progress) => request(`/lessons/${id}/review-progress`, { method: 'PUT', body: progress }),
  // deck: a lesson id, or 'all'
  listDecks: (signal) => request('/flashcards/decks', { signal }),
  getDue: (deck, signal) => request(deck === 'all' ? '/flashcards/due' : `/lessons/${deck}/flashcards/due`, { signal }),
  answerCard: (cardId, { rating, timeMs, deck }) =>
    request(`/flashcards/${cardId}/review`, { method: 'POST', body: { rating, time_ms: timeMs, deck: deck === 'all' ? null : deck } }),
  undoAnswer: (reviewId, deck) => request(`/flashcards/reviews/${reviewId}/undo`, { method: 'POST', body: { deck: deck === 'all' ? null : deck } }),
  makeFlashcards: (lessonId) => request(`/lessons/${lessonId}/flashcards/generate`, { method: 'POST', admin: true }),
  listQuizzes: (signal) => request('/quiz', { signal }),
  // retakeOf: an earlier attempt's id, to get the same questions in a new order
  startQuiz: (lessonId, retakeOf) => request(`/lessons/${lessonId}/quiz/attempts`, { method: 'POST', body: retakeOf ? { retake_of: retakeOf } : {} }),
  answerQuestion: (attemptId, { position, choice, timeMs }) =>
    request(`/quiz/attempts/${attemptId}/answers`, { method: 'POST', body: { position, choice, time_ms: timeMs } }),
  finishQuiz: (attemptId, totalMs) => request(`/quiz/attempts/${attemptId}/finish`, { method: 'POST', body: { total_ms: totalMs } }),

  // participants, sessions, events, stats
  checkParticipant: (code) => request(`/participants/${encodeURIComponent(code)}`),
  // `as`: the participant the session belongs to, so its last report still goes out under that code after a switch
  startSession: (lessonId, activity, as) => request('/sessions', { method: 'POST', body: { lesson_id: lessonId, activity }, keepalive: true, as }),
  // { active_ms, end_reason?, ended_ago_ms? }
  reportSession: (id, report, as) => quietly(request(`/sessions/${id}`, { method: 'POST', body: report, keepalive: true, as })),
  // type: stats_view | review_flashcards_tap | section_simplify | section_translate
  logEvent: (type, extra = {}) => quietly(request('/events', { method: 'POST', body: { type, ...extra }, keepalive: true })),
  getStats: (signal) => request('/stats', { signal }),

  // admin (the PIN header is added once admin is unlocked)
  unlockAdmin: (pin) =>
    fetch('/api/admin/unlock', { method: 'POST', headers: { 'x-admin-pin': pin } }).then(
      async (res) => {
        if (res.ok) return true;
        const data = await res.json().catch(() => null);
        throw new ApiError(data?.error?.message ?? `The server answered with an error (${res.status}).`, res.status, data?.error?.code ?? null);
      },
      () => {
        throw new ApiError(UNREACHABLE);
      },
    ),
  adminParticipants: (signal) => request('/admin/participants', { signal, admin: true }),
  addParticipants: (codes) => request('/admin/participants', { method: 'POST', body: { codes }, admin: true }),
  adminStats: (code, signal) => request(`/admin/participants/${encodeURIComponent(code)}/stats`, { signal, admin: true }),
  downloadExport: (file, includeP00) => {
    const q = includeP00 ? '?include_p00=1' : '';
    return file === 'all' ? download(`/admin/export.zip${q}`, 'studyrevr-export.zip') : download(`/admin/export/${file}.csv${q}`, `${file}.csv`);
  },
};
