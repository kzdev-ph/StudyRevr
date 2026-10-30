import { useState } from 'react';
import MyAiSettings from '../components/MyAiSettings.jsx';
import { api } from '../lib/api.js';
import { getMotionChoice, setMotionChoice } from '../lib/motion.js';
import { signOut, useAccount } from '../lib/auth.js';
import { getThemeChoice, setThemeChoice } from '../lib/theme.js';

const CHOICES = [
  { id: 'system', label: 'Match my device' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'ama', label: 'AMA' },
  { id: 'ama-dark', label: 'AMA Dark' },
];

const MOTION = [
  { id: 'system', label: 'Match my device' },
  { id: 'less', label: 'Less motion' },
  { id: 'full', label: 'Full motion' },
];

export default function SettingsScreen() {
  const [theme, setTheme] = useState(getThemeChoice);
  const [motion, setMotion] = useState(getMotionChoice);
  const account = useAccount();
  const [leaving, setLeaving] = useState(false);
  const leave = async () => {
    setLeaving(true);
    await signOut();
  };
  const choose = (id) => {
    if (id === theme) return;
    setThemeChoice(id);
    setTheme(id);
    api.logSettingEvent('theme', id);
  };

  const chooseMotion = (id) => {
    if (id === motion) return;
    setMotionChoice(id);
    setMotion(id);
    api.logSettingEvent('motion', id);
  };

  return (
    <section className="stack">
      <h1 className="screen-title">Settings</h1>
      <div className="setting-row">
        <p className="setting-row__text">
          <span className="setting-row__title">{account?.email ? `Signed in as ${account.email}` : 'Signed in'}</span>
          <span className="muted">Everything you study is saved to this account.</span>
        </p>
        <button type="button" className="btn btn--quiet" onClick={leave} disabled={leaving}>
          {leaving ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
      <fieldset className="choice">
        <legend>Appearance</legend>
        <div className="segmented">
          {CHOICES.map(({ id, label }) => (
            <label key={id} className="segmented__item">
              <input type="radio" name="theme" value={id} checked={theme === id} onChange={() => choose(id)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="choice">
        <legend>Motion</legend>
        <div className="segmented">
          {MOTION.map(({ id, label }) => (
            <label key={id} className="segmented__item">
              <input type="radio" name="motion" value={id} checked={motion === id} onChange={() => chooseMotion(id)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <MyAiSettings />
    </section>
  );
}
