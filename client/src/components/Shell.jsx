import { CardsIcon, GearIcon, LogoMark, QuizIcon, ReviewIcon, StatsIcon } from './Icons.jsx';
import { paths } from '../lib/router.js';

const TABS = [
  { id: 'review', label: 'Review', Icon: ReviewIcon, to: paths.library() },
  { id: 'flashcards', label: 'Flashcard', Icon: CardsIcon, to: paths.tab('flashcards') },
  { id: 'quiz', label: 'Mock Quiz', Icon: QuizIcon, to: paths.tab('quiz') },
  { id: 'stats', label: 'Stats', Icon: StatsIcon, to: paths.tab('stats') },
];

// The chip shows who is signed in: the part of the email before the "@" (tap it for the account, in Settings).
export function Header({ settingsActive, signedIn, email }) {
  return (
    <header className="header">
      <a className="wordmark" href={paths.library()}>
        <LogoMark />
        <span>StudyRevr</span>
      </a>
      {signedIn && (
        <div className="header__end">
          {email && (
            <a className="participant-chip" href={paths.tab('settings')} aria-label={`Signed in as ${email}. Account settings`} title="Account settings">
              <span>{email.split('@')[0]}</span>
            </a>
          )}
          <a className="icon-btn" href={paths.tab('settings')} aria-label="Settings" title="Settings" aria-current={settingsActive ? 'page' : undefined}>
            <GearIcon />
          </a>
        </div>
      )}
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
