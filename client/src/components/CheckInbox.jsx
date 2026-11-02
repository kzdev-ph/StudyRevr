import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { isGmail } from '../lib/authForms.js';
import Notice from './Notice.jsx';

const COOLDOWN_SECONDS = 60;

// Shown after sign-up or an unverified sign-in: the link was sent (or could not be); the student can ask for another.
export default function CheckInbox({ email, sent, lead, onBack }) {
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0); // seconds left before the link can be sent again
  const [resent, setResent] = useState(false);
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const timer = setTimeout(() => setWait((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const resend = async () => {
    setBusy(true);
    setProblem(null);
    setResent(false);
    try {
      await api.resendVerification(email);
      setResent(true);
      setWait(COOLDOWN_SECONDS);
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  // "Promotions" is a Gmail tab; other mailboxes call it Junk.
  const hint = `Can't find it? Look in ${isGmail(email) ? 'Spam or Promotions' : 'your Spam or Junk folder'}. The link works for 24 hours.`;

  return (
    <div className="stack stack--tight">
      {/* After a resend the success line says it all: no lead warning, no second "we sent a link" sentence */}
      {resent ? (
        <>
          <Notice tone="info">If this email still needs verifying, a new link is on its way. Only the newest link works.</Notice>
          <p className="muted">{hint}</p>
        </>
      ) : (
        <>
          {lead && <Notice tone="warn">{lead}</Notice>}
          {sent ? (
            <>
              <p>
                We sent a link to <strong>{email}</strong>. Open it on any device to verify your email, then sign in here.
              </p>
              <p className="muted">{hint}</p>
            </>
          ) : (
            <>
              <p>
                Your email <strong>{email}</strong> still needs to be verified, then you can sign in here.
              </p>
              <Notice>We couldn't send the email just now. Tap Send the link again, or ask your teacher.</Notice>
            </>
          )}
        </>
      )}
      {problem && <Notice>{problem}</Notice>}
      <button type="button" className="btn btn--quiet" onClick={resend} disabled={busy || wait > 0}>
        {busy ? 'Sending…' : wait > 0 ? `Send again in ${wait} s` : 'Send the link again'}
      </button>
      <button type="button" className="btn btn--primary" onClick={onBack}>
        Back to sign in
      </button>
    </div>
  );
}
