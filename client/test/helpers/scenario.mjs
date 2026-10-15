// One student sitting, driven by real clicks and keys on the real screens, in a fake browser with a fake clock
// (helpers/env.mjs). It prints the time_ms the app sent to the server for each answer, as JSON. The test file runs it
// with motion on and with reduced motion, and compares. Everything the student does is timed from what is on screen,
// so the two runs are the same student.
//   MODE=natural: the animations run to their end.  MODE=skip: the student taps through the deck and the hand-out.
import { advance, reduced, sched, settle, until } from './env.mjs';

Math.random = () => 0.9; // four riffles for the deck

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { default: StudyScreen } = await import('../../src/screens/StudyScreen.jsx');
const { default: QuizRunScreen } = await import('../../src/screens/QuizRunScreen.jsx');
const { setParticipant } = await import('../../src/lib/participant.js');

setParticipant('P01');
const mode = process.env.MODE ?? 'natural';

// ---- the server --------------------------------------------------------------------------------------------------
const sent = { reviews: [], answers: [] };
const buttons = [1, 2, 3, 4].map((rating) => ({ rating, label: rating === 1 ? '1m' : '1d' }));
const card = (id) => ({ id, front: `Front ${id}`, back: `Back ${id}`, evidence: null, kind: 'concept', queue: 'new', buttons, lesson_title: 'Lesson' });
const deck = { lesson_id: 1, title: 'Lesson' };
const counts = { new: 2, learning: 0, due: 0 };
let reviewId = 0;
const questions = [0, 1].map((position) => ({ position, type: 'mc', kind: 'concept', question: `Question ${position}`, choices: ['A', 'B', 'C', 'D'] }));

const json = (data, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => data });
globalThis.fetch = (url, init = {}) => {
  const path = String(url).replace(/^\/api/, '');
  const body = init.body ? JSON.parse(init.body) : null;
  if (path === '/lessons/1/flashcards/due') return json({ deck, counts, total: 2, card: card(1), next_due_at: null });
  if (/^\/flashcards\/\d+\/review$/.test(path)) {
    sent.reviews.push(body.time_ms);
    reviewId += 1;
    return json({ review_id: reviewId, deck, counts, total: 2, card: reviewId < 2 ? card(2) : null, next_due_at: null });
  }
  if (path === '/sessions') return json({ session: { id: 1 } });
  if (path.startsWith('/sessions/')) return json({});
  if (path === '/lessons/1/quiz/attempts') return json({ attempt: { id: 7, title: 'Lesson' }, questions, notice: null, resumed: false });
  if (path === '/quiz/attempts/7/answers') {
    sent.answers.push(body.time_ms);
    return json({ correct: true, chosen_index: body.choice, answer_index: body.choice, answer_text: 'A', evidence: null });
  }
  if (path === '/quiz/attempts/7/finish') {
    return json({ attempt: { id: 7, lesson_id: 1, score: 2, total: 2, percent: 100, duration_ms: 1000 }, missed: [], previous_best_percent: null });
  }
  return json({});
};

// ---- the student -------------------------------------------------------------------------------------------------
const q = (sel) => document.querySelector(sel);
const byText = (sel, text) => [...document.querySelectorAll(sel)].find((el) => el.textContent.includes(text));
const press = async (el, type = 'click') => {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true }));
  });
};
const key = async (k) => {
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
};
const showAnswer = () => byText('button', 'Show answer');
const rating = () => [...document.querySelectorAll('.rate__btn')];
const ready = () => rating().length > 0 && rating().every((b) => b.getAttribute('aria-disabled') !== 'true');
const setHidden = async (hidden) => {
  sched.hidden = hidden;
  await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
};

const out = { reduced, mode };
const root = createRoot(document.getElementById('root'));

// Flashcards. Card 1: read 2.5 s, turn it, try to rate it before it has turned, read the answer 1.2 s, rate Good.
// Card 2: 1 s on the front, the app hidden for a minute (a locked phone), 2.1 s more on the front, turn it, 0.9 s on the
// back, rate Easy.
await act(async () => root.render(React.createElement(StudyScreen, { deck: 1 })));
await settle(act);
if (mode === 'skip') {
  await advance(act, 160); // the deck is on the table
  await press(q('.shuffle')); // a tap skips it
}
await until(act, () => showAnswer());
await advance(act, 2500);
await press(showAnswer());
await advance(act, 40); // the card is still turning
await key('3');
if (rating()[2]) await press(rating()[2]);
out.ratedMidTurn = sent.reviews.length;
out.readyMidTurn = ready();
await until(act, ready);
await advance(act, 1200);
await press(rating()[2]);
await settle(act);
await until(act, () => showAnswer());
await advance(act, 1000);
await setHidden(true);
await advance(act, 60000);
await setHidden(false);
await advance(act, 2100);
await press(showAnswer());
await until(act, ready);
await advance(act, 900);
await press(rating()[3]);
await settle(act);
out.cards = sent.reviews;

// Quiz: the sheet is handed out; question 1 after 6.4 s, question 2 after 5.2 s.
await act(async () => root.render(React.createElement(QuizRunScreen, { lessonId: 1 })));
await settle(act);
await until(act, () => q('.quiz-paper'));
if (mode === 'skip') {
  await advance(act, 100);
  await press(q('.quiz-paper'), 'pointerdown'); // a tap skips the hand-out
} else {
  await until(act, () => !q('.quiz-paper').style.opacity);
}
await advance(act, 6400);
await press(document.querySelectorAll('.quiz-opt')[0]);
await until(act, () => byText('button', 'Next question'));
await press(byText('button', 'Next question'));
await settle(act);
await advance(act, 5200);
await press(document.querySelectorAll('.quiz-opt')[1]);
await settle(act);
out.answers = sent.answers;

console.log(`RESULT ${JSON.stringify(out)}`);
process.exit(0);
