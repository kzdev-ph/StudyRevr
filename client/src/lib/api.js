export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

const UNREACHABLE = "Can't reach the StudyRevr server. Make sure it is running, then try again.";

async function request(path, { method = 'GET', body, form, signal } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
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
    throw new ApiError(message ?? `The server answered with an error (${res.status}).`, res.status);
  }
  return data;
}

export const api = {
  listLessons: (signal) => request('/lessons', { signal }),
  getLesson: (id, signal) => request(`/lessons/${id}`, { signal }),
  getStatus: (id, signal) => request(`/lessons/${id}/status`, { signal }),
  uploadLesson: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/lessons', { method: 'POST', form });
  },
  retryLesson: (id) => request(`/lessons/${id}/retry`, { method: 'POST' }),
  deleteLesson: (id) => request(`/lessons/${id}`, { method: 'DELETE' }),
  simplifySection: (id) => request(`/sections/${id}/simplify`, { method: 'POST' }),
  translateSection: (id) => request(`/sections/${id}/translate`, { method: 'POST' }),
  saveProgress: (id, progress) => request(`/lessons/${id}/review-progress`, { method: 'PUT', body: progress }),
  // deck: a lesson id, or 'all'
  listDecks: (signal) => request('/flashcards/decks', { signal }),
  getDue: (deck, signal) => request(deck === 'all' ? '/flashcards/due' : `/lessons/${deck}/flashcards/due`, { signal }),
  answerCard: (cardId, { rating, timeMs, deck }) =>
    request(`/flashcards/${cardId}/review`, { method: 'POST', body: { rating, time_ms: timeMs, deck: deck === 'all' ? null : deck } }),
  undoAnswer: (reviewId, deck) => request(`/flashcards/reviews/${reviewId}/undo`, { method: 'POST', body: { deck: deck === 'all' ? null : deck } }),
  makeFlashcards: (lessonId) => request(`/lessons/${lessonId}/flashcards/generate`, { method: 'POST' }),
  listQuizzes: (signal) => request('/quiz', { signal }),
  // retakeOf: an earlier attempt's id, to get the same questions in a new order
  startQuiz: (lessonId, retakeOf) => request(`/lessons/${lessonId}/quiz/attempts`, { method: 'POST', body: retakeOf ? { retake_of: retakeOf } : {} }),
  answerQuestion: (attemptId, { position, choice, timeMs }) =>
    request(`/quiz/attempts/${attemptId}/answers`, { method: 'POST', body: { position, choice, time_ms: timeMs } }),
  finishQuiz: (attemptId, totalMs) => request(`/quiz/attempts/${attemptId}/finish`, { method: 'POST', body: { total_ms: totalMs } }),
};
