import { useEffect, useRef, useState } from 'react';
import GateCard from '../components/GateCard.jsx';
import Notice from '../components/Notice.jsx';
import { api } from '../lib/api.js';
import { forgetLinkToken, navigate, paths } from '../lib/router.js';

// Opened from the link in the verification email, signed in or not. The token is kept in memory and taken out of the
// address bar; the button (not the page load) uses it, so a mail scanner that only opens the link can't spend it.
export default function VerifyEmailScreen({ token: fromLink }) {
  const [token, setToken] = useState(fromLink);
  const [state, setState] = useState(token ? 'ready' : 'missing'); // ready | busy | done | failed | missing
  const [message, setMessage] = useState('');
  const latest = useRef(token); // the token the screen is for now, to drop a late answer about an older link

  // A link arrives (on mount, or another one opened in this same tab, which does not remount the screen): keep its token,
  // start over, and take it out of the address bar. The route drops the token after that, so null is ignored.
  useEffect(() => {
    if (!fromLink) return;
    latest.current = fromLink;
    setToken(fromLink);
    setState('ready');
    setMessage('');
    forgetLinkToken('verify');
  }, [fromLink]);

  const verify = async () => {
    const used = token;
    setState('busy');
    try {
      await api.verifyEmail(used);
      if (latest.current === used) setState('done');
    } catch (err) {
      if (latest.current !== used) return;
      setMessage(err.message);
      setState('failed');
    }
  };

  const toSignIn = () => navigate(paths.library());
  const signInButton = (
    <button type="button" className="btn btn--primary" onClick={toSignIn}>
      Go to sign in
    </button>
  );

  return (
    <GateCard title="Verify your email">
      {(state === 'ready' || state === 'busy') && (
        <>
          <p>Tap the button to finish verifying your StudyRevr email.</p>
          <p className="muted">Only verify if you made this StudyRevr account yourself. If you did not, ignore the email.</p>
          <button type="button" className="btn btn--primary" onClick={verify} disabled={state === 'busy'}>
            {state === 'busy' ? 'Verifying…' : 'Verify my email'}
          </button>
        </>
      )}
      {state === 'done' && (
        <>
          <Notice tone="info">Your email is verified. You can sign in now.</Notice>
          {signInButton}
        </>
      )}
      {state === 'failed' && (
        <>
          <Notice>{message}</Notice>
          {signInButton}
        </>
      )}
      {state === 'missing' && (
        <>
          <Notice>This link can't be used again here. Open the newest link in your email, or sign in to get a new one.</Notice>
          {signInButton}
        </>
      )}
    </GateCard>
  );
}
