import { useState } from 'react';
import { getThemeChoice, setThemeChoice } from '../lib/theme.js';

const CHOICES = [
  { id: 'system', label: 'Match my device' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export default function SettingsScreen() {
  const [theme, setTheme] = useState(getThemeChoice);
  const choose = (id) => {
    setThemeChoice(id);
    setTheme(id);
  };

  return (
    <section className="stack">
      <h1 className="screen-title">Settings</h1>
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
    </section>
  );
}
