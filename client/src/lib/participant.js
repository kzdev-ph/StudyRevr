import { useSyncExternalStore } from 'react';
import { lockAdmin } from './admin.js';
import { local, storedValue } from './store.js';

// The participant code this device studies as (P01, P02, ...). Saved on the device until "Switch participant".
// The server checks the code on every request; the app only remembers it.

const CODE = /^P\s*-?\s*(\d{1,3})$/i;

// The same rule as the server: "p7", "P 7" and "P007" all mean P07. null when it isn't a code.
export function normalizeCode(text) {
  const m = CODE.exec(String(text ?? '').trim());
  return m ? `P${String(Number(m[1])).padStart(2, '0')}` : null;
}

const store = storedValue('studyrevr.participant', local);

export const getParticipant = store.get;
export const setParticipant = (code) => store.set(code ? normalizeCode(code) : null);
export const useParticipant = () => useSyncExternalStore(store.subscribe, store.get, () => null);

// Called before the participant changes, so an open study session can end first (reason 'switched').
const beforeSwitch = new Set();
export const onBeforeSwitch = (fn) => {
  beforeSwitch.add(fn);
  return () => beforeSwitch.delete(fn);
};
// Switching ends the study session, locks admin again (the next person on this tab is a student) and forgets the code.
export function switchParticipant() {
  for (const fn of beforeSwitch) fn();
  lockAdmin();
  setParticipant(null);
}
