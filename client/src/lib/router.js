import { useSyncExternalStore } from 'react';

// A tiny hash router: the back button works and a reload keeps the screen, with no extra dependency.
//   #/review                  lesson library
//   #/review/12               lesson 12, sections (also #/review/12/points and #/review/12/terms)
//   #/flashcards  #/quiz  #/stats  #/settings

const LESSON_VIEWS = ['sections', 'points', 'terms'];
const TABS = ['flashcards', 'quiz', 'stats', 'settings'];

export function parseRoute(hash) {
  const parts = String(hash ?? '').replace(/^#\/?/, '').split('/').filter(Boolean);
  const [first, second, third] = parts;
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
};

export const navigate = (to) => {
  window.location.hash = to;
};

const subscribe = (callback) => {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
};

export const useRoute = () => parseRoute(useSyncExternalStore(subscribe, () => window.location.hash));

// Which bottom tab a route belongs to (Settings has no tab).
export const tabOf = (route) => (route.name === 'library' || route.name === 'lesson' ? 'review' : route.name);
