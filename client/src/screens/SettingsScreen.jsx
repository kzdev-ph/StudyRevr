import { useState } from 'react';
import MyAiSettings from '../components/MyAiSettings.jsx';
import { switchParticipant, useParticipant } from '../lib/participant.js';
import { getThemeChoice, setThemeChoice } from '../lib/theme.js';

const CHOICES = [
  { id: 'system', label: 'Match my device' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export default function SettingsScreen() {
  const [theme, setTheme] = useState(getThemeChoice);
  const participant = useParticipant();
  const choose = (id) => {
    setThemeChoice(id);
    setTheme(id);
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
      <MyAiSettings />
    </section>
  );
}
