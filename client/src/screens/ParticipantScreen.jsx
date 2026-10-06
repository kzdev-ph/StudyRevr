import { useState } from 'react';
import { LogoMark } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import { api } from '../lib/api.js';
import { normalizeCode, setParticipant } from '../lib/participant.js';
import { paths } from '../lib/router.js';

const NOT_LISTED = "That code isn't on the list. Check with your teacher.";

// Shown until this device knows who is studying. Type-only: codes are never listed or suggested here.
export default function ParticipantScreen() {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState(null);
  const [checking, setChecking] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const code = normalizeCode(text);
    if (!code) return setProblem('Codes look like P01. Check the code your teacher gave you.');
    setChecking(true);
    setProblem(null);
    try {
      await api.checkParticipant(code);
      setParticipant(code);
    } catch (err) {
      setProblem(err.status === 404 ? NOT_LISTED : err.message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="gate" id="main">
      <div className="gate__card stack">
        <span className="wordmark" aria-hidden="true">
          <LogoMark />
          <span>StudyRevr</span>
        </span>
        <h1 className="screen-title">Who’s studying?</h1>
        <form className="stack stack--tight" onSubmit={submit} noValidate>
          <label className="field">
            <span className="field__label">Your participant code</span>
            <input
              className="field__input gate__input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
              placeholder="P01"
              aria-describedby={problem ? 'gate-problem' : 'gate-hint'}
              aria-invalid={problem ? true : undefined}
              autoFocus
            />
          </label>
          {problem ? (
            <div id="gate-problem">
              <Notice>{problem}</Notice>
            </div>
          ) : (
            <p id="gate-hint" className="muted">
              Your teacher gave you a code like P01. No password needed.
            </p>
          )}
          <button type="submit" className="btn btn--primary" disabled={checking || !text.trim()}>
            {checking ? 'Checking…' : 'Start studying'}
          </button>
        </form>
        <a className="link-btn gate__admin" href={paths.admin()}>
          Researcher admin
        </a>
      </div>
    </main>
  );
}
