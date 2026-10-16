import { useSyncExternalStore } from 'react';

// Motion: Match my device (default) / Less motion / Full motion. Kept like the theme (lib/theme.js): a choice in
// localStorage on this device, written to data-motion on <html> for the CSS. Every animation in the app asks
// useMotionReduced() (never matchMedia or motion's own useReducedMotion), so there is one answer. It is visual only:
// the answer clock (lib/answerClock.js) never reads it, so time_ms is the same with every choice.
const KEY = 'studyrevr-motion';
const QUERY = '(prefers-reduced-motion: reduce)';
export const MOTION_CHOICES = ['system', 'less', 'full'];

const read = () => {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'less' || v === 'full' ? v : 'system';
  } catch {
    return 'system';
  }
};

// less -> reduced, full -> not, system -> whatever the device says
export const resolveReduced = (choice, deviceReduces) => (choice === 'less' ? true : choice === 'full' ? false : Boolean(deviceReduces));

export function applyMotion(choice = read(), root = document.documentElement) {
  if (choice === 'less' || choice === 'full') root.dataset.motion = choice;
  else delete root.dataset.motion;
}

export const getMotionChoice = read;

const listeners = new Set();
let current = null; // the choice this page is using (the storage is read once; a blocked storage still works)

export function setMotionChoice(choice) {
  current = MOTION_CHOICES.includes(choice) ? choice : 'system';
  try {
    if (current === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, current);
  } catch {
    // storage blocked: the choice still applies for this visit
  }
  applyMotion(current);
  listeners.forEach((l) => l());
}

const choice = () => (current ??= read());
const device = () => Boolean(window.matchMedia?.(QUERY).matches);

// For code outside a component (a scroll behaviour read when it runs)
export const motionReduced = () => resolveReduced(choice(), device());

function subscribe(onChange) {
  listeners.add(onChange);
  const query = window.matchMedia?.(QUERY);
  query?.addEventListener?.('change', onChange);
  return () => {
    listeners.delete(onChange);
    query?.removeEventListener?.('change', onChange);
  };
}

// True when this screen should use the plain version of an animation (a fade, or none)
export const useMotionReduced = () => useSyncExternalStore(subscribe, motionReduced, () => false);
