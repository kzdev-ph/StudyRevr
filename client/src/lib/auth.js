import { useSyncExternalStore } from 'react';
import { lockAdmin } from './admin.js';
import { api } from './api.js';
import { local, session, storedValue } from './store.js';

// Who is signed in on this device. The login token is kept on the device and never expires by time: the server ends a
// login (another device signs in, the teacher signs the student out, the password is reset) and the next request
// says so. The account (email, must change its password) is only remembered in memory and read again from the server.

const TOKEN_KEY = 'studyrevr.auth-token';
const token = storedValue(TOKEN_KEY, local);
const notice = storedValue('studyrevr.signed-out', session); // what the sign-in screen tells the student, once

export const getToken = token.get;
export const setToken = (value) => token.set(value);
export const onTokenChange = token.subscribe;
export const useToken = () => useSyncExternalStore(token.subscribe, token.get, () => null);
export const useSignedIn = () => useSyncExternalStore(token.subscribe, () => Boolean(token.get()), () => false);

// Another tab signed in or out: every tab follows (the account is read again once the new token is known).
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event) => {
    if (event.key !== TOKEN_KEY && event.key !== null) return;
    setAccountValue(null);
    token.notify();
  });
}

// ---- the account: { email, must_change_password } ------------------------------------------------------------------
let account = null;
const accountListeners = new Set();
const subscribeAccount = (fn) => {
  accountListeners.add(fn);
  return () => accountListeners.delete(fn);
};
function setAccountValue(value) {
  account = value ?? null;
  for (const fn of accountListeners) fn();
}

export const setAccount = setAccountValue;
export const getAccount = () => account;
export const useAccount = () => useSyncExternalStore(subscribeAccount, () => account, () => null);
export const useMustChangePassword = () => Boolean(useAccount()?.must_change_password);
// The server refused a request until the temporary password is replaced.
export const markMustChange = () => setAccountValue({ ...account, email: account?.email ?? '', must_change_password: true });

// A sign-in, sign-up or password change succeeded: { token, account } from the server.
export function acceptLogin({ token: value, account: who }) {
  setAccountValue(who);
  token.set(value);
}

// ---- signed-out notices --------------------------------------------------------------------------------------------
const NOTICES = {
  signed_out_elsewhere: 'You were signed out because your account was opened on another device.',
  signed_out_by_admin: 'Your teacher signed you out. Sign in again.',
  password_reset: 'Your teacher reset your password. Sign in with the new one.',
};
const SIGN_IN_AGAIN = 'Please sign in again.';

// The message for the sign-in screen, once.
export function takeSignedOutNotice() {
  const message = notice.get();
  notice.set(null);
  return message;
}

// ---- signing out ---------------------------------------------------------------------------------------------------
const WAIT_MS = 2000;
const handlers = new Set();
let signingOut = false;

// An open study session ends first (it sends its last report with the token). `fn` may return a promise.
export const onBeforeSignOut = (fn) => {
  handlers.add(fn);
  return () => handlers.delete(fn);
};

const clearAll = () => {
  token.set(null);
  setAccountValue(null);
  lockAdmin();
};

// The student signs out: the handlers get up to 2 s to finish, then the server is told (an error changes nothing: the
// token is dropped either way).
export async function signOut() {
  signingOut = true;
  try {
    const waits = [...handlers].map(async (fn) => fn());
    let timer;
    const limit = new Promise((resolve) => {
      timer = setTimeout(resolve, WAIT_MS);
    });
    await Promise.race([Promise.allSettled(waits), limit]);
    clearTimeout(timer);
    await api.logout().catch(() => null);
  } finally {
    clearAll();
    signingOut = false;
  }
}

// The server ended this login (a 401 with `code`): back to sign-in with the reason. No server call. `sentToken` is the
// token of the request that was refused; a late answer about an old token must not sign out a newer login.
export function signedOutByServer(code, sentToken = token.get()) {
  if (signingOut || !sentToken || sentToken !== token.get()) return;
  notice.set(NOTICES[code] ?? SIGN_IN_AGAIN);
  clearAll();
}
