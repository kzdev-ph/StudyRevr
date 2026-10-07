import { motion } from 'motion/react';
import { CardsIcon, GearIcon, LogoMark, QuizIcon, ReviewIcon, StatsIcon } from './Icons.jsx';
import { paths } from '../lib/router.js';

const TABS = [
  { id: 'review', label: 'Review', Icon: ReviewIcon, to: paths.library() },
  { id: 'flashcards', label: 'Flashcard', Icon: CardsIcon, to: paths.tab('flashcards') },
  { id: 'quiz', label: 'Mock Quiz', Icon: QuizIcon, to: paths.tab('quiz') },
  { id: 'stats', label: 'Stats', Icon: StatsIcon, to: paths.tab('stats') },
];

// The participant chip shows who this device is studying as (tap it to switch, in Settings).
export function Header({ settingsActive, participant }) {
  return (
    <header className="header">
      <a className="wordmark" href={paths.library()}>
        <LogoMark />
        <span>StudyRevr</span>
      </a>
      {participant && (
        <div className="header__end">
          <a className="participant-chip" href={paths.tab('settings')} aria-label={`Studying as ${participant}. Switch participant`} title="Switch participant in Settings">
            <span>{participant}</span>
          </a>
          <a className="icon-btn" href={paths.tab('settings')} aria-label="Settings" title="Settings" aria-current={settingsActive ? 'page' : undefined}>
            <GearIcon />
          </a>
        </div>
      )}
    </header>
  );
}

// Divider tabs: a bar at the bottom of a phone, standing out of the page's left edge on a wide screen. The open tab is
// a paper divider that slides to the tab you open (MotionConfig turns the slide off under reduced motion), and its
// label gets the highlighter.
export function TabBar({ active }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map(({ id, label, Icon, to }) => (
        <a key={id} className="tab" href={to} aria-current={active === id ? 'page' : undefined}>
          {active === id && <motion.span layoutId="tab-mark" className="tab__mark" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
          <Icon className="tab__icon" />
          <span className={active === id ? 'tab__label mk mk--draw' : 'tab__label'}>{label}</span>
        </a>
      ))}
    </nav>
  );
}
