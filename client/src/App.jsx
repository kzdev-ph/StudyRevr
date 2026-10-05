import { useEffect, useRef } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Header, TabBar } from './components/Shell.jsx';
import { useRoute, tabOf } from './lib/router.js';
import LibraryScreen from './screens/LibraryScreen.jsx';
import LessonScreen from './screens/LessonScreen.jsx';
import PlaceholderScreen from './screens/PlaceholderScreen.jsx';
import SettingsScreen from './screens/SettingsScreen.jsx';

function Screen({ route }) {
  switch (route.name) {
    case 'lesson':
      return <LessonScreen key={route.lessonId} id={route.lessonId} view={route.view} />;
    case 'flashcards':
    case 'quiz':
    case 'stats':
      return <PlaceholderScreen which={route.name} />;
    case 'settings':
      return <SettingsScreen />;
    default:
      return <LibraryScreen />;
  }
}

export default function App() {
  const route = useRoute();
  const mainRef = useRef(null);
  const screenKey = route.name === 'lesson' ? `lesson-${route.lessonId}` : route.name;

  // A new screen starts at the top, and keyboard / screen-reader focus moves to it.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    mainRef.current?.focus({ preventScroll: true });
  }, [screenKey]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="app">
        <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>
          Skip to content
        </a>
        <Header settingsActive={route.name === 'settings'} />
        <TabBar active={tabOf(route)} />
        <main id="main" className="main" ref={mainRef} tabIndex={-1}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={screenKey} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
              <Screen route={route} />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </MotionConfig>
  );
}
