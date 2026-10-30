import { lazy, Suspense, useEffect, useRef } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Header, TabBar } from './components/Shell.jsx';
import { usePresence } from './hooks/usePresence.js';
import { lockAdmin } from './lib/admin.js';
import { useAccount, useMustChangePassword, useSignedIn } from './lib/auth.js';
import { useMotionReduced } from './lib/motion.js';
import { isAdminRoute, useRoute, tabOf } from './lib/router.js';
import AdminScreen from './screens/AdminScreen.jsx';
import LibraryScreen from './screens/LibraryScreen.jsx';
import LessonScreen from './screens/LessonScreen.jsx';
import FlashcardsScreen from './screens/FlashcardsScreen.jsx';
import AuthScreen from './screens/AuthScreen.jsx';
import ChangePasswordScreen from './screens/ChangePasswordScreen.jsx';
import QuizRunScreen from './screens/QuizRunScreen.jsx';
import QuizScreen from './screens/QuizScreen.jsx';
import SettingsScreen from './screens/SettingsScreen.jsx';
import StudyScreen from './screens/StudyScreen.jsx';

// Stats and the admin participant view load only when opened, so the study screens stay light on a phone.
const StatsScreen = lazy(() => import('./screens/StatsScreen.jsx'));
const AdminParticipantScreen = lazy(() => import('./screens/AdminParticipantScreen.jsx'));
const AdminLessonScreen = lazy(() => import('./screens/AdminLessonScreen.jsx'));
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
    case 'adminLesson':
      return (
        <Suspense fallback={loading}>
          <AdminLessonScreen key={route.lessonId} lessonId={route.lessonId} />
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
  const signedIn = useSignedIn();
  const account = useAccount();
  const mustChange = useMustChangePassword();
  const reduced = useMotionReduced();
  const adminRoute = isAdminRoute(route);
  usePresence();

  // Admin stays unlocked only while an admin screen is open: leaving them locks it again, so a student on this tab
  // is never admin.
  useEffect(() => {
    if (!adminRoute) lockAdmin();
  }, [adminRoute]);
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

  // Signing in from the sign-in screen (or choosing the new password) replaces it with the app: move focus to the new
  // screen, not to nothing.
  const inApp = signedIn && !mustChange;
  const hadApp = useRef(inApp);
  useEffect(() => {
    if (inApp && !hadApp.current) {
      window.scrollTo({ top: 0 });
      mainRef.current?.focus({ preventScroll: true });
    }
    hadApp.current = inApp;
  }, [inApp]);

  // Until this device is signed in, only the sign-in screen (and the researcher's admin) can open; after a password
  // reset, the new password comes first.
  if (!adminRoute && (!signedIn || mustChange)) {
    return (
      <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
        {signedIn ? <ChangePasswordScreen /> : <AuthScreen />}
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <div className="app">
        <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>
          Skip to content
        </a>
        <Header settingsActive={route.name === 'settings'} signedIn={signedIn} email={account?.email} />
        {signedIn && <TabBar active={tabOf(route)} />}
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
