import { useEffect, useRef } from 'react';
import { api } from '../lib/api.js';

const DELAY_MS = 350;

// Saves { last_section, completed_sections } shortly after they change, and once more when the screen closes, so the
// lesson reopens where the student left off. Saving is quiet: a failed save never interrupts reading.
export function useSavedProgress(lessonId, lastSection, completed, saved) {
  const latest = useRef(null);
  const lastSaved = useRef(JSON.stringify(saved));
  const body = { last_section: lastSection, completed_sections: [...completed].sort((a, b) => a - b) };
  const key = JSON.stringify(body);
  latest.current = { body, key };

  const flush = () => {
    const { body: pending, key: pendingKey } = latest.current;
    if (pendingKey === lastSaved.current) return;
    lastSaved.current = pendingKey;
    api.saveProgress(lessonId, pending).catch(() => {
      lastSaved.current = null; // try again on the next change
    });
  };

  useEffect(() => {
    const timer = setTimeout(flush, DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => flush, []); // eslint-disable-line react-hooks/exhaustive-deps
}

// The saved progress as the hook compares it: the server's row, or the starting position.
export const initialProgress = (progress) => ({
  last_section: progress?.last_section ?? 0,
  completed_sections: progress?.completed_sections ?? [],
});
