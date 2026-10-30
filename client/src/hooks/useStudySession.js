import { useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { getToken, onBeforeSignOut } from '../lib/auth.js';
import { createSessionTracker } from '../lib/session.js';

const INTERACTIONS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];

// Logs active study time while this screen is open (see lib/session.js for the rules).
//   lessonId  the lesson (null: the All lessons flashcard deck);  activity  'reading' | 'flashcards' | 'quiz'
// -> a function giving the active time so far on this screen, over every session it ran (the flashcard recap).
export function useStudySession(lessonId, activity, { enabled = true } = {}) {
  const tracker = useRef(null);

  useEffect(() => {
    const who = getToken();
    if (!enabled || !who) return undefined;
    const t = createSessionTracker({
      start: async () => (await api.startSession(lessonId, activity, who)).session.id,
      report: (id, body) => api.reportSession(id, body, who),
      visible: document.visibilityState !== 'hidden',
    });
    tracker.current = t;
    t.open();

    const onInteract = () => t.interaction();
    const onVisibility = () => (document.visibilityState === 'hidden' ? t.hide() : t.show());
    const onPageHide = () => t.hide();
    const opts = { passive: true, capture: true };
    for (const type of INTERACTIONS) window.addEventListener(type, onInteract, opts);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    const offSignOut = onBeforeSignOut(() => t.close('signed_out'));

    return () => {
      for (const type of INTERACTIONS) window.removeEventListener(type, onInteract, opts);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      offSignOut();
      t.close('left');
    };
  }, [lessonId, activity, enabled]);

  return () => tracker.current?.totalActiveMs() ?? 0;
}
