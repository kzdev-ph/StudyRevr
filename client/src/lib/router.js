import { useSyncExternalStore } from 'react';

// A tiny hash router: the back button works and a reload keeps the screen, with no extra dependency.
//   #/review                  lesson library
//   #/review/12               lesson 12, sections (also #/review/12/points and #/review/12/terms)
//   #/flashcards              decks (one per lesson, plus All lessons)
//   #/flashcards/all          study every lesson's cards;  #/flashcards/12  study lesson 12
//   #/quiz                    quizzes (one row per lesson);  #/quiz/12  take the quiz on lesson 12
//   #/stats  #/settings
//   #/admin                   researcher admin (PIN);  #/admin/participants/P03  that participant's stats

const LESSON_VIEWS = ['sections', 'points', 'terms'];
const TABS = ['flashcards', 'quiz', 'stats', 'settings'];

export function parseRoute(hash) {
  const parts = String(hash ?? '').replace(/^#\/?/, '').split('/').filter(Boolean);
  const [first, second, third] = parts;
  if (first === 'flashcards' && (second === 'all' || /^\d+$/.test(second ?? ''))) {
    return { name: 'study', deck: second === 'all' ? 'all' : Number(second) };
  }
  if (first === 'quiz' && /^\d+$/.test(second ?? '')) return { name: 'quizRun', lessonId: Number(second) };
  if (first === 'admin') {
    return second === 'participants' && /^P\d{1,3}$/i.test(third ?? '') ? { name: 'adminParticipant', code: third.toUpperCase() } : { name: 'admin' };
  }
  if (TABS.includes(first)) return { name: first };
  if (first === 'review' && /^\d+$/.test(second ?? '')) {
    return { name: 'lesson', lessonId: Number(second), view: LESSON_VIEWS.includes(third) ? third : 'sections' };
  }
  return { name: 'library' };
}

export const paths = {
  library: () => '#/review',
  lesson: (id, view = 'sections') => (view === 'sections' ? `#/review/${id}` : `#/review/${id}/${view}`),
  tab: (name) => `#/${name}`,
  study: (deck) => `#/flashcards/${deck}`,
  quiz: (lessonId) => `#/quiz/${lessonId}`,
  admin: () => '#/admin',
  adminParticipant: (code) => `#/admin/participants/${code}`,
};

export const navigate = (to) => {
  window.location.hash = to;
};

const subscribe = (callback) => {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
};

export const useRoute = () => parseRoute(useSyncExternalStore(subscribe, () => window.location.hash));

// Which bottom tab a route belongs to (Settings and admin have no tab).
export const tabOf = (route) => {
  if (route.name === 'admin' || route.name === 'adminParticipant') return null;
  if (route.name === 'library' || route.name === 'lesson') return 'review';
  if (route.name === 'study') return 'flashcards';
  return route.name === 'quizRun' ? 'quiz' : route.name;
};
