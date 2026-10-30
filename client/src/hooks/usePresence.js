import { useEffect } from 'react';
import { api } from '../lib/api.js';
import { setAccount, useToken } from '../lib/auth.js';

// The server treats a device as still here when it was seen within the session timeout (30 s at the least, and it only
// notes the time every 10 s), so a ping every 15 s keeps a live device from looking idle and being replaced without the
// "Continue here?" question.
export const PING_MS = 15_000;

// While signed in and in front, asks the server who is signed in: at once, then every PING_MS. Paused while the app is
// hidden. The reply also keeps the account fresh (a teacher's password reset shows as must_change_password). A refused
// ping (signed out elsewhere) is handled by the api layer, which sends this device back to sign-in.
export function usePresence() {
  const token = useToken();

  useEffect(() => {
    if (!token) return undefined;
    let timer = null;
    let pending = null;

    const ping = async () => {
      pending?.abort();
      const mine = new AbortController();
      pending = mine;
      try {
        const { account } = await api.me(mine.signal);
        if (!mine.signal.aborted && account) setAccount(account);
      } catch {
        // offline or refused: the next ping tries again; a refusal was already handled
      }
    };
    const stop = () => {
      clearInterval(timer);
      timer = null;
      pending?.abort();
    };
    const start = () => {
      stop();
      ping();
      timer = setInterval(ping, PING_MS);
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start());

    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [token]);
}
