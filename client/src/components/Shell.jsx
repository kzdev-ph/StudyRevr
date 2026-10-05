import { motion } from 'motion/react';
import { CardsIcon, GearIcon, LogoMark, QuizIcon, ReviewIcon, StatsIcon } from './Icons.jsx';
import { paths } from '../lib/router.js';

const TABS = [
  { id: 'review', label: 'Review', Icon: ReviewIcon, to: paths.library() },
  { id: 'flashcards', label: 'Flashcards', Icon: CardsIcon, to: paths.tab('flashcards') },
  { id: 'quiz', label: 'Mock Quiz', Icon: QuizIcon, to: paths.tab('quiz') },
  { id: 'stats', label: 'Stats', Icon: StatsIcon, to: paths.tab('stats') },
];

export function Header({ settingsActive }) {
  return (
    <header className="header">
      <a className="wordmark" href={paths.library()}>
        <LogoMark />
        <span>StudyRevr</span>
      </a>
      <a className="icon-btn" href={paths.tab('settings')} aria-label="Settings" title="Settings" aria-current={settingsActive ? 'page' : undefined}>
        <GearIcon />
      </a>
    </header>
  );
}

// Bottom bar on a phone, a left rail on a wide screen. The highlighter mark slides to the tab you open.
export function TabBar({ active }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map(({ id, label, Icon, to }) => (
        <a key={id} className="tab" href={to} aria-current={active === id ? 'page' : undefined}>
          {active === id && <motion.span layoutId="tab-mark" className="tab__mark" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
          <Icon className="tab__icon" />
          <span className="tab__label">{label}</span>
        </a>
      ))}
    </nav>
  );
}
