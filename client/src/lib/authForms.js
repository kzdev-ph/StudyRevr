// Shared checks for the account forms (the server checks again).

export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

// The server's /api/health answer -> whether it can send email. A missing field or a failed call (null) counts as off.
export const emailIsOn = (health) => health?.email === true;

// What the sign-in footer shows for the health answer: 'wait' (not answered yet, show nothing), 'link' (Forgot password?
// link) or 'teacher' (ask your teacher). `answer` is undefined before the call ends, the health object, or null when it failed.
export function forgotFooter(answer) {
  if (answer === undefined) return 'wait';
  return emailIsOn(answer) ? 'link' : 'teacher';
}

// Is this a Gmail address (gmail.com or googlemail.com)?
export function isGmail(email) {
  const domain = String(email || '').trim().toLowerCase().split('@').pop();
  return domain === 'gmail.com' || domain === 'googlemail.com';
}

// The mailbox to name in the check-your-inbox panel: "your Gmail inbox" for a Gmail address, else "your inbox".
export const inboxName = (email) => (isGmail(email) ? 'your Gmail inbox' : 'your inbox');

// A new password typed twice -> the message to show, or null when it is fine.
export function newPasswordProblem(password, again) {
  if (!password || !again) return 'Enter the new password twice.';
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (password !== again) return 'The two passwords are not the same. Type them again.';
  return null;
}
