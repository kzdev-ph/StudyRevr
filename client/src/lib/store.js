// A tiny observable value saved in web storage, for useSyncExternalStore. Storage can be missing or throw (private
// mode, blocked site data); the value then lives in memory for this visit.
export function storedValue(key, storage) {
  let memory = null;
  let memoryOnly = false; // storage refused a write: this visit's value is the one in memory
  const listeners = new Set();
  // Storage that works is the truth, so another tab removing the value is seen here too (no stale copy in memory).
  const read = () => {
    if (memoryOnly) return memory;
    try {
      const store = storage();
      return store ? store.getItem(key) : memory;
    } catch {
      return memory;
    }
  };
  return {
    get: read,
    set(value) {
      memory = value || null;
      try {
        if (value) storage()?.setItem(key, value);
        else storage()?.removeItem(key);
        memoryOnly = false;
      } catch {
        memoryOnly = true; // memory only
      }
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // the stored value changed somewhere else (another tab's `storage` event): tell the subscribers to read it again
    notify() {
      for (const fn of listeners) fn();
    },
  };
}

export const local = () => (typeof localStorage === 'undefined' ? null : localStorage);
export const session = () => (typeof sessionStorage === 'undefined' ? null : sessionStorage);
