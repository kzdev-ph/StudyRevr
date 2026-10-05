export class ApiError extends Error {
  constructor(message, status = 0, hint = null) {
    super(message);
    this.status = status;
    this.hint = hint; // developer hint from the server, shown behind "Details"
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
    throw new ApiError(message ?? `The server answered with an error (${res.status}).`, res.status, data?.error?.hint ?? null);
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
};
