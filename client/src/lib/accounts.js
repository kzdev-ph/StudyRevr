// How the admin Accounts table words an account's state (the server sends the facts; see GET /api/admin/accounts).

const hhmm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// P00 is the researcher's own test login; for everyone else the most pressing fact wins.
export function accountStatus(account) {
  if (account.test) return 'Your test login';
  if (account.locked_until) return `Locked until ${hhmm(account.locked_until)}`;
  if (account.must_change_password) return 'Must change password';
  if (account.active_now) return 'Active now';
  if (account.signed_in) return 'Signed in';
  return 'Signed out';
}
