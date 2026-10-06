import { useSyncExternalStore } from 'react';
import { session, storedValue } from './store.js';

// The admin PIN, once it has worked, kept for this browser session only (closing the browser locks admin again).
// The server checks it on every admin request; holding it here only saves typing it again.
const store = storedValue('studyrevr.admin-pin', session);

export const getAdminPin = store.get;
export const setAdminPin = (pin) => store.set(pin);
export const lockAdmin = () => store.set(null);
export const useAdminPin = () => useSyncExternalStore(store.subscribe, store.get, () => null);
