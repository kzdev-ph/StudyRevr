import { useState, useSyncExternalStore } from 'react';
import MyAiSettings from '../components/MyAiSettings.jsx';
import { api } from '../lib/api.js';
import { getMotionChoice, setMotionChoice } from '../lib/motion.js';
import { switchParticipant, useParticipant } from '../lib/participant.js';
import { getThemeChoice, setThemeChoice, subscribeTheme } from '../lib/theme.js';

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
  const theme = useSyncExternalStore(subscribeTheme, getThemeChoice, () => 'ama'); // also moves when the header switch is tapped
  const [motion, setMotion] = useState(getMotionChoice);
  const participant = useParticipant();
  const choose = (id) => {
    if (id === theme) return;
    setThemeChoice(id);
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
          <span className="setting-row__title">Participant {participant}</span>
          <span className="muted">Everything you study is saved under this code.</span>
        </p>
        <button type="button" className="btn btn--quiet" onClick={() => switchParticipant()}>
          Switch participant
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
