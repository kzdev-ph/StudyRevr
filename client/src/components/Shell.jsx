import { useSyncExternalStore } from 'react';
import { CardsIcon, GearIcon, LogoMark, MoonIcon, QuizIcon, ReviewIcon, StatsIcon, SunIcon } from './Icons.jsx';
import { api } from '../lib/api.js';
import { paths } from '../lib/router.js';
import { flippedTheme, setThemeChoice, shownTheme, subscribeTheme } from '../lib/theme.js';

const TABS = [
  { id: 'review', label: 'Review', Icon: ReviewIcon, to: paths.library() },
  { id: 'flashcards', label: 'Flashcards', Icon: CardsIcon, to: paths.tab('flashcards') },
  { id: 'quiz', label: 'Mock Quiz', Icon: QuizIcon, to: paths.tab('quiz') },
  { id: 'stats', label: 'Stats', Icon: StatsIcon, to: paths.tab('stats') },
];

// One tap between light and dark (AMA stays AMA). It follows the choice made here or in Settings, and logs the same
// setting event Settings does.
function ThemeToggle() {
  const shown = useSyncExternalStore(subscribeTheme, shownTheme, () => 'light');
  const dark = shown === 'dark' || shown === 'ama-dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  const flip = () => {
    const next = flippedTheme();
    setThemeChoice(next);
    api.logSettingEvent('theme', next);
  };
  return (
    <button type="button" className="icon-btn" onClick={flip} aria-label={label} title={label}>
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

// The participant chip shows who this device is studying as (tap it to switch, in Settings).
export function Header({ settingsActive, participant }) {
  return (
    <header className="header">
      <a className="wordmark" href={paths.library()}>
        <LogoMark />
        <span>StudyRevr</span>
      </a>
      <div className="header__end">
        {participant && (
          <a className="participant-chip" href={paths.tab('settings')} aria-label={`Studying as ${participant}. Switch participant`} title="Switch participant in Settings">
            <span>{participant}</span>
          </a>
        )}
        <ThemeToggle />
        {participant && (
          <a className="icon-btn" href={paths.tab('settings')} aria-label="Settings" title="Settings" aria-current={settingsActive ? 'page' : undefined}>
            <GearIcon />
          </a>
        )}
      </div>
    </header>
  );
}

// The four main screens: a plain bar at the bottom of a phone, a quiet column beside the page on a wide screen. The
// open one gets the highlighter on its label (drawn in once; not at all under reduced motion).
export function TabBar({ active }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map(({ id, label, Icon, to }) => (
        <a key={id} className="tab" href={to} aria-current={active === id ? 'page' : undefined}>
          <Icon className="tab__icon" />
          <span className={active === id ? 'tab__label mk mk--draw' : 'tab__label'}>{label}</span>
        </a>
      ))}
    </nav>
  );
}
