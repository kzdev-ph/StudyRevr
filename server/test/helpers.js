import { z } from 'zod';
import { createAiClient } from '../src/ai/client.js';

// Shared by the AI tests. Nothing here touches the network: every "provider" is a scripted fetch.
export const KEY = 'AIza-SECRET-KEY-123';
export const CFG = { baseUrl: 'https://example.test/v1/', apiKey: KEY, model: 'acme/chat-1' };

export const completion = (content, extra = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: extra.finish ?? 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

export const failure = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// Scripted fetch: each call takes the next entry (a Response, or a function returning/throwing one); the last repeats.
export function scriptedFetch(...steps) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return typeof step === 'function' ? step() : step.clone();
  };
  fn.calls = calls;
  return fn;
}

export const makeClient = (fetchImpl, cfg = CFG, extra = {}) => {
  const sleeps = [];
  const client = createAiClient({ getConfig: () => cfg, fetchImpl, sleep: async (ms) => void sleeps.push(ms), random: () => 0, ...extra });
  client.sleeps = sleeps;
  return client;
};

export const schema = z.object({ answer: z.string().min(1), n: z.number() });

// A verbatim quote for a key-terms mock: the first few words of the lesson text inside a prompt's <lesson_text> block.
export const quoteFromPrompt = (user, words = 6) =>
  (/<lesson_text>\n([^]*?)\n<\/lesson_text>/.exec(user)?.[1] ?? '').split(/\s+/).slice(0, words).join(' ');

// Quick checks a sections mock can return that pass the grounding in code (pipeline/quick-checks.js): each quotes the
// start of the lesson text in the prompt (its [Slide N] labels left out) and answers with words of that quote.
export const groundedChecks = (user, n = 2) => {
  const text = (/<lesson_text>\n([^]*?)\n<\/lesson_text>/.exec(user)?.[1] ?? '').replace(/^\[(?:Slide|Page|Paragraph) \d+\]\n/gm, '');
  const quote = text.split(/\s+/).slice(0, 8).join(' ');
  const words = quote.split(' ');
  return Array.from({ length: n }, (_, i) => ({ question: `Question ${i + 1}?`, answer: `${words.slice(i + 1, i + 4).join(' ')}.`, evidence: quote }));
};

// A quick-check review mock (services/check-review.js) that flags nothing: one clean entry per section in the prompt.
export const cleanCheckReview = (user) => ({ sections: [...user.matchAll(/^\[(\d+)\] Section:/gm)].map((m) => ({ n: Number(m[1]), checks: [] })) });

// A key-terms merge mock that keeps every candidate, in the order given (version 1 each).
export const keepAllCandidates = (user) => ({ terms: [...user.matchAll(/^\[(\d+)\] /gm)].map((m) => ({ id: Number(m[1]) })) });

// Phase 6: the API tests from earlier phases act as participant P00 (made by migration 008) with the admin PIN, so
// their requests pass the participant and admin checks unchanged. Each such file shadows `fetch` with studyFetch and
// adds `adminPin: TEST_PIN` to its app config. Tests of the checks themselves use the real fetch.
export const TEST_PIN = 'test-pin-2468';
export const STUDY_HEADERS = { 'x-participant': 'P00', 'x-admin-pin': TEST_PIN };
export const studyFetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { ...STUDY_HEADERS, ...init.headers } });

// A running app on an in-memory database for the Phase 6 tests, with a settable clock.
//   const t = await startStudyApp({ now: '2026-10-05T04:00:00.000Z' });
//   await t.call('POST', '/api/sessions', { as: 'P01', body: {...} })   // as: participant code; pin: admin PIN
//   t.now = '...'  moves the clock;  await t.close()
// `showTaglish` (default true here, false in the app) sets admin's "Show Filipino/Taglish to students".
export async function startStudyApp({ now = '2026-10-05T04:00:00.000Z', adminPin = TEST_PIN, ai, random, runner = { enqueue() {} }, db: given, showTaglish = true } = {}) {
  const { openDb, runMigrations } = await import('../src/db/index.js');
  const { createApp } = await import('../src/app.js');
  const db = given ?? openDb(':memory:');
  if (!given) runMigrations(db);
  if (showTaglish) db.prepare("INSERT INTO settings (key, value) VALUES ('show_taglish', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'").run();
  const t = { db, now };
  ai ??= { async generateJSON() { throw new Error('no AI in this test'); } };
  const app = createApp(db, { maxUploadBytes: 1024 * 1024, adminPin, clientDist: null }, { ai, runner, clock: () => new Date(t.now), random });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.base = base;
  t.app = app; // for tests that read the live router stack (lesson-access.test.js)
  t.call = async (method, path, { as, pin, body, raw = false } = {}) => {
    const headers = {};
    if (as) headers['x-participant'] = as;
    if (pin) headers['x-admin-pin'] = pin;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await globalThis.fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return res;
    const text = await res.text();
    return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, headers: res.headers };
  };
  t.close = async () => {
    await new Promise((resolve) => server.close(resolve));
    if (!given) db.close();
  };
  return t;
}

// Test data straight into the database: a ready lesson with `n` concept flashcards. -> { lessonId, cards: [ids] }
// Every card is about "the topic", and so are the fake wrong answers, so the quiz's leak checks (quiz/leaks.js) let
// them through.
const ANSWER_WORDS = 'rivers mountains forests deserts islands valleys oceans glaciers meadows canyons volcanoes beaches lakes plains swamps caves reefs dunes cliffs bays'.split(' ');
const SEED_TEXT = 'The topic of this lesson: alpha, beta and gamma, with a right and a wrong answer.';
export function seedLesson(db, { title = 'Inquiry', n = 4, created = '2026-10-01T00:00:00.000Z' } = {}) {
  const lessonId = Number(
    db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status, created_at) VALUES (?, ?, ?, 200, 'ready', ?)").run(title, `${title}.pptx`, SEED_TEXT, created).lastInsertRowid,
  );
  const insert = db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, 'concept', ?, ?, 'quote from the lesson', ?)");
  // each answer has words of its own: two answers that differ only in a number are one answer to the leak checks
  const cards = Array.from({ length: n }, (_, i) => Number(insert.run(lessonId, `Q${lessonId}.${i + 1}: what is said about the topic?`, `Topic answer ${i + 1} of ${title}: ${ANSWER_WORDS[(2 * i) % ANSWER_WORDS.length]} ${ANSWER_WORDS[(2 * i + 1) % ANSWER_WORDS.length]}.`, i + 1).lastInsertRowid));
  db.prepare("INSERT INTO sections (lesson_id, position, title, content) VALUES (?, 0, 'One', 'c'), (?, 1, 'Two', 'c')").run(lessonId, lessonId);
  return { lessonId, cards };
}

export const addCodes = (db, ...codes) => {
  const insert = db.prepare('INSERT OR IGNORE INTO participants (code) VALUES (?)');
  for (const c of codes) insert.run(c);
};

// Every route of a running app, read from the live Express stack (Express 5: `app.router.stack`), as 'METHOD /full/path'
// ('/api' included, a trailing slash dropped). A mounted router must carry the `mountPath` that app.js's mount() gives it;
// one that doesn't is listed in `untagged` instead of being walked, so a router mounted by hand can't hide its routes.
//   const { routes, untagged } = liveRoutes(app)
export function liveRoutes(app) {
  const routes = [];
  const untagged = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const path = typeof layer.route.path === 'string' ? layer.route.path : String(layer.route.path);
        const full = `${prefix}${path}`.replace(/(.)\/$/, '$1');
        for (const method of Object.keys(layer.route.methods)) routes.push(`${method === '_all' ? 'ALL' : method.toUpperCase()} ${full}`);
      } else if (layer.handle?.stack) {
        if (typeof layer.handle.mountPath !== 'string') untagged.push(layer.name || 'router');
        else walk(layer.handle.stack, `${prefix}${layer.handle.mountPath}`);
      }
    }
  };
  walk(app.router.stack, '');
  return { routes, untagged };
}

// A quiz-review mock (services/quiz-review.js) that flags nothing: one clean entry per item in the prompt.
export const cleanReview = (user) => ({
  items: [...user.matchAll(/^\[(\d+)\] (?:Term|Concept) card/gm)].map((m) => ({ n: Number(m[1]), card: [], set: [], true_statement: [], options: [] })),
  families: [],
});
