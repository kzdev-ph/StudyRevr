import { lazy, Suspense, useEffect, useRef } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Header, TabBar } from './components/Shell.jsx';
import { useMotionReduced } from './lib/motion.js';
import { useParticipant } from './lib/participant.js';
import { useRoute, tabOf } from './lib/router.js';
import AdminScreen from './screens/AdminScreen.jsx';
import LibraryScreen from './screens/LibraryScreen.jsx';
import LessonScreen from './screens/LessonScreen.jsx';
import FlashcardsScreen from './screens/FlashcardsScreen.jsx';
import ParticipantScreen from './screens/ParticipantScreen.jsx';
import QuizRunScreen from './screens/QuizRunScreen.jsx';
import QuizScreen from './screens/QuizScreen.jsx';
import SettingsScreen from './screens/SettingsScreen.jsx';
import StudyScreen from './screens/StudyScreen.jsx';

// Stats and the admin participant view load only when opened, so the study screens stay light on a phone.
const StatsScreen = lazy(() => import('./screens/StatsScreen.jsx'));
const AdminParticipantScreen = lazy(() => import('./screens/AdminParticipantScreen.jsx'));
const loading = <p className="muted" aria-live="polite">Loading…</p>;

function Screen({ route }) {
  switch (route.name) {
    case 'lesson':
      return <LessonScreen key={route.lessonId} id={route.lessonId} view={route.view} />;
    case 'flashcards':
      return <FlashcardsScreen />;
    case 'study':
      return <StudyScreen key={route.deck} deck={route.deck} />;
    case 'quiz':
      return <QuizScreen />;
    case 'quizRun':
      return <QuizRunScreen key={route.lessonId} lessonId={route.lessonId} />;
    case 'stats':
      return (
        <Suspense fallback={loading}>
          <StatsScreen />
        </Suspense>
      );
    case 'admin':
      return <AdminScreen />;
    case 'adminParticipant':
      return (
        <Suspense fallback={loading}>
          <AdminParticipantScreen key={route.code} code={route.code} />
        </Suspense>
      );
    case 'settings':
      return <SettingsScreen />;
    default:
      return <LibraryScreen />;
  }
}

export default function App() {
  const route = useRoute();
  const participant = useParticipant();
  const reduced = useMotionReduced();
  const adminRoute = route.name === 'admin' || route.name === 'adminParticipant';
  const mainRef = useRef(null);
  const screenKey =
    route.name === 'lesson'
      ? `lesson-${route.lessonId}`
      : route.name === 'study'
        ? `study-${route.deck}`
        : route.name === 'quizRun'
          ? `quiz-${route.lessonId}`
          : route.name === 'adminParticipant'
            ? `admin-${route.code}`
            : route.name;

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

  // Signing in from the code screen replaces it with the app: move focus to the new screen, not to nothing.
  const hadParticipant = useRef(participant);
  useEffect(() => {
    if (participant && !hadParticipant.current) {
      window.scrollTo({ top: 0 });
      mainRef.current?.focus({ preventScroll: true });
    }
    hadParticipant.current = participant;
  }, [participant]);

  // Until this device knows who is studying, only the code screen (and the researcher's admin) can open.
  if (!participant && !adminRoute) {
    return (
      <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
        <ParticipantScreen />
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <div className="app">
        <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>
          Skip to content
        </a>
        <Header settingsActive={route.name === 'settings'} participant={participant} />
        {participant && <TabBar active={tabOf(route)} />}
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
