import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addCodes, liveRoutes, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

// Phase 7B: a student's upload is private to its owner until admin shares it. Every route that reads or writes a lesson
// (directly, or through a card, section, review or attempt that belongs to one) answers 404 "not found" for anyone who
// may not see it, never 403, so a private lesson can't even be told apart from one that doesn't exist.

const MISSING = [401, 403, 404];

// The routes. `records`: the thing in the path belongs to the owner's own study records (a review, an attempt), so
// nobody else can use it even once the lesson is shared. `adminOnly`: behind the PIN, which comes before the lesson
// check. `owns`: only the owner (or admin) may use it, shared or not.
const ROUTES = [
  { name: 'GET /lessons/:id', method: 'GET', url: (c) => `/api/lessons/${c.lesson}` },
  { name: 'GET /lessons/:id/status', method: 'GET', url: (c) => `/api/lessons/${c.lesson}/status` },
  { name: 'GET /lessons/:id/review-progress', method: 'GET', url: (c) => `/api/lessons/${c.lesson}/review-progress` },
  { name: 'PUT /lessons/:id/review-progress', method: 'PUT', url: (c) => `/api/lessons/${c.lesson}/review-progress`, body: () => ({ last_section: 0, completed_sections: [] }) },
  { name: 'POST /lessons/:id/retry', method: 'POST', url: (c) => `/api/lessons/${c.lesson}/retry`, owns: true },
  { name: 'GET /lessons/:id/flashcards/due', method: 'GET', url: (c) => `/api/lessons/${c.lesson}/flashcards/due` },
  { name: 'POST /flashcards/:id/review', method: 'POST', url: (c) => `/api/flashcards/${c.card}/review`, body: () => ({ rating: 3, time_ms: 1000, deck: null }) },
  { name: 'POST /flashcards/reviews/:id/undo', method: 'POST', url: (c) => `/api/flashcards/reviews/${c.review}/undo`, body: () => ({ deck: null }), records: true },
  { name: 'POST /lessons/:id/quiz/attempts', method: 'POST', url: (c) => `/api/lessons/${c.lesson}/quiz/attempts`, body: () => ({}) },
  { name: 'POST /quiz/attempts/:id/answers', method: 'POST', url: (c) => `/api/quiz/attempts/${c.attempt}/answers`, body: () => ({ position: 0, choice: 0, time_ms: 500 }), records: true },
  { name: 'POST /quiz/attempts/:id/finish', method: 'POST', url: (c) => `/api/quiz/attempts/${c.attempt}/finish`, body: () => ({ total_ms: 1000 }), records: true },
  { name: 'POST /sections/:id/simplify', method: 'POST', url: (c) => `/api/sections/${c.section}/simplify` },
  { name: 'POST /sections/:id/translate', method: 'POST', url: (c) => `/api/sections/${c.section}/translate` },
  { name: 'POST /sessions', method: 'POST', url: () => '/api/sessions', body: (c) => ({ lesson_id: c.lesson, activity: 'reading' }) },
  { name: 'POST /events', method: 'POST', url: () => '/api/events', body: (c) => ({ type: 'section_simplify', lesson_id: c.lesson, section_index: 0 }) },
  { name: 'POST /lessons/:id/quiz-options', method: 'POST', url: (c) => `/api/lessons/${c.lesson}/quiz-options`, adminOnly: true },
  { name: 'POST /lessons/:id/section-versions', method: 'POST', url: (c) => `/api/lessons/${c.lesson}/section-versions`, adminOnly: true },
  { name: 'POST /lessons/:id/flashcards/generate', method: 'POST', url: (c) => `/api/lessons/${c.lesson}/flashcards/generate`, adminOnly: true },
  { name: 'POST /lessons/:id/share', method: 'POST', url: (c) => `/api/lessons/${c.lesson}/share`, adminOnly: true },
  { name: 'DELETE /lessons/:id', method: 'DELETE', url: (c) => `/api/lessons/${c.lesson}`, deletes: true },
];

// Routes that list lessons or their cards: checked below for what they leave out.
const LISTS = new Set(['GET /lessons', 'GET /flashcards/decks', 'GET /flashcards/due', 'GET /quiz']);

// Routes that don't take a lesson at all (the coverage test makes a new route say so here).
const NOT_LESSON_ROUTES = new Set([
  'POST /lessons', // upload: tested in student-uploads.test.js
  'GET /my-uploads',
  'POST /sessions/:id', // a session id of the caller's own (participant-scoped)
  'POST /setting-events',
  'GET /health',
  'GET /participants/:code', // checks a code; says nothing about lessons
  'GET /stats', // the caller's own numbers
  'GET /my-ai',
  'POST /my-ai/models',
  'POST /my-ai/key',
  'DELETE /my-ai/key',
]);

// Everything under these prefixes is behind the admin PIN (the last coverage test calls each route without it).
const PIN_PREFIXES = ['/admin', '/settings'];

// The routes of a live app that the tables above don't account for: what the coverage test must find empty. Routes
// under the PIN prefixes are left to the PIN test. Every other route, with a parameter or without, must be listed: a
// lesson route in ROUTES with its own checks, a list in LISTS, or NOT_LESSON_ROUTES with the reason it needs none.
function unclassifiedRoutes(app) {
  const known = new Set([...ROUTES.map((r) => r.name), ...LISTS, ...NOT_LESSON_ROUTES]);
  const { routes, untagged } = liveRoutes(app);
  const missing = untagged.map((n) => `${n}: a router mounted without mount() in app.js`);
  for (const route of routes) {
    const [method, full] = route.split(' ');
    const rel = full.replace(/^\/api/, '') || '/';
    if (PIN_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
    if (!known.has(`${method} ${rel}`)) missing.push(`${method} ${rel}`);
  }
  return missing;
}

describe('lesson visibility', () => {
  let t;
  let c; // ids
  const as = { owner: { as: 'P01' }, other: { as: 'P02' }, admin: { as: 'P00', pin: TEST_PIN }, none: {} };

  const call = (route, who) => t.call(route.method, route.url(c), { ...as[who], body: route.body?.(c) });

  before(async () => {
    t = await startStudyApp();
    addCodes(t.db, 'P01', 'P02');
    const owner = t.db.prepare("SELECT id FROM participants WHERE code = 'P01'").get().id;
    const teacher = seedLesson(t.db, { title: 'Teacher lesson' });
    const mine = seedLesson(t.db, { title: 'Private upload' });
    t.db.prepare("UPDATE lessons SET origin = 'student', owner_participant_id = ? WHERE id = ?").run(owner, mine.lessonId);
    const section = t.db.prepare('SELECT id FROM sections WHERE lesson_id = ? ORDER BY position').get(mine.lessonId).id;
    // the owner's own records: a flashcard answer and a quiz attempt
    const review = await t.call('POST', `/api/flashcards/${mine.cards[0]}/review`, { as: 'P01', body: { rating: 3, time_ms: 1000, deck: null } });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    const attempt = await t.call('POST', `/api/lessons/${mine.lessonId}/quiz/attempts`, { as: 'P01', body: {} });
    assert.equal(attempt.status, 201, JSON.stringify(attempt.body));
    const find = (body, keys) => keys.map((k) => k.split('.').reduce((o, p) => o?.[p], body)).find((v) => Number.isInteger(v));
    c = {
      teacher: teacher.lessonId,
      lesson: mine.lessonId,
      card: mine.cards[0],
      section,
      review: find(review.body, ['review.id', 'review_id', 'id']),
      attempt: find(attempt.body, ['attempt.id', 'attempt_id', 'id']),
    };
    assert.ok(c.review && c.attempt, `review/attempt ids: ${JSON.stringify([review.body, attempt.body])}`);
  });
  after(() => t.close());

  const mutating = ROUTES.filter((r) => !r.deletes && !r.adminOnly);

  describe('a private lesson', () => {
    for (const route of mutating) {
      it(`${route.name}: the owner may, nobody else may (404)`, async () => {
        const owner = await call(route, 'owner');
        assert.ok(!MISSING.includes(owner.status), `owner got ${owner.status} ${JSON.stringify(owner.body)}`);
        const other = await call(route, 'other');
        assert.equal(other.status, 404, `another student got ${other.status} ${JSON.stringify(other.body)}`);
        assert.match(other.body.error?.message ?? '', /not found/i);
        const none = await call(route, 'none');
        assert.ok([401, 404].includes(none.status), `no headers got ${none.status}`);
        const admin = await call(route, 'admin');
        if (route.records) assert.equal(admin.status, 404, 'a record belongs to the participant who made it');
        else assert.ok(!MISSING.includes(admin.status), `admin got ${admin.status} ${JSON.stringify(admin.body)}`);
      });
    }

    for (const route of ROUTES.filter((r) => r.adminOnly)) {
      it(`${route.name}: behind the PIN, before any lesson is looked up`, async () => {
        for (const who of ['owner', 'other', 'none']) assert.equal((await call(route, who)).status, 401, who);
        // a wrong PIN is no better, and the owner's code doesn't make a student an admin
        const wrong = await t.call(route.method, route.url(c), { as: 'P01', pin: 'wrong-pin', body: route.body?.(c) });
        assert.equal(wrong.status, 401);
      });
    }

    it('DELETE /lessons/:id: another student gets 404, no headers get 401 or 404; the owner, who has studied it, is refused', async () => {
      const route = ROUTES.find((r) => r.deletes);
      assert.equal((await call(route, 'other')).status, 404);
      assert.ok([401, 404].includes((await call(route, 'none')).status));
      const owner = await call(route, 'owner');
      assert.equal(owner.status, 409);
      assert.equal(owner.body.error.code, 'lesson_studied');
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons WHERE id = ?').get(c.lesson).n, 1);
    });

    it('the lists leave a private lesson out for everyone but its owner (and admin)', async () => {
      for (const [who, sees] of [['owner', true], ['other', false], ['admin', true]]) {
        const lessons = await t.call('GET', '/api/lessons', as[who]);
        assert.equal(lessons.status, 200);
        assert.equal(lessons.body.lessons.some((l) => l.id === c.lesson), sees, `GET /lessons as ${who}`);
        assert.ok(lessons.body.lessons.some((l) => l.id === c.teacher), "the teacher's lesson is always listed");
        const decks = await t.call('GET', '/api/flashcards/decks', as[who]);
        assert.equal(decks.status, 200);
        assert.equal(JSON.stringify(decks.body).includes('Private upload'), sees, `decks as ${who}`);
        const quiz = await t.call('GET', '/api/quiz', as[who]);
        assert.equal(quiz.status, 200);
        assert.equal(JSON.stringify(quiz.body).includes('Private upload'), sees, `quiz list as ${who}`);
      }
      const none = await t.call('GET', '/api/lessons', as.none);
      assert.equal(none.body.lessons.some((l) => l.id === c.lesson), false, 'GET /lessons with no headers');
    });

    it("the All lessons deck never offers another student's private card", async () => {
      const other = await t.call('GET', '/api/flashcards/due', as.other);
      assert.equal(other.status, 200);
      assert.equal(JSON.stringify(other.body).includes('Private upload'), false);
      assert.equal(JSON.stringify(other.body).includes(`Q${c.lesson}.`), false);
    });

    it('answering a private card as another student saves nothing for them', async () => {
      const res = await t.call('POST', `/api/flashcards/${c.card}/review`, { as: 'P02', body: { rating: 3, time_ms: 1000, deck: null } });
      assert.equal(res.status, 404);
      const n = (table) => t.db.prepare(`SELECT COUNT(*) AS n FROM ${table} x JOIN participants q ON q.id = x.participant_id WHERE q.code = 'P02'`).get().n;
      assert.equal(n('flashcard_progress'), 0);
      assert.equal(n('flashcard_reviews'), 0);
      assert.equal(n('study_sessions'), 0);
      assert.equal(n('events'), 0);
    });

    it('a card that does not exist and a card of a private lesson answer alike, before the body is even read', async () => {
      for (const body of [{}, { rating: 9 }, { rating: 3, time_ms: -1 }, { rating: 3 }]) {
        const missing = await t.call('POST', '/api/flashcards/987654/review', { ...as.other, body });
        const hidden = await t.call('POST', `/api/flashcards/${c.card}/review`, { ...as.other, body });
        assert.equal(missing.status, 404, JSON.stringify(body));
        assert.deepEqual(hidden.body, missing.body, JSON.stringify(body));
        assert.match(missing.body.error.message, /Flashcard not found/);
      }
    });

    it('an unknown lesson and another student\'s private lesson answer with the same 404', async () => {
      const missing = await t.call('GET', '/api/lessons/99999', as.other);
      const hidden = await t.call('GET', `/api/lessons/${c.lesson}`, as.other);
      assert.equal(missing.status, 404);
      assert.deepEqual(hidden.body, missing.body);
    });
  });

  describe('after admin shares it', () => {
    before(async () => {
      const res = await t.call('POST', `/api/lessons/${c.lesson}/share`, as.admin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    for (const route of mutating.filter((r) => !r.owns)) {
      it(`${route.name}: another student may, except for the owner's own records`, async () => {
        const other = await call(route, 'other');
        if (route.records) assert.equal(other.status, 404);
        else assert.ok(!MISSING.includes(other.status), `another student got ${other.status} ${JSON.stringify(other.body)}`);
      });
    }

    it('retry stays the owner\'s: another student still gets 404', async () => {
      const route = ROUTES.find((r) => r.name === 'POST /lessons/:id/retry');
      assert.equal((await call(route, 'other')).status, 404);
    });

    it("the lists now include it, and a student who can see it can't tell who uploaded it", async () => {
      const lessons = await t.call('GET', '/api/lessons', as.other);
      const row = lessons.body.lessons.find((l) => l.id === c.lesson);
      assert.ok(row);
      assert.equal(row.mine, false);
      assert.equal(row.shared, true);
      assert.equal('owner_code' in row, false);
      assert.equal('owner_participant_id' in row, false);
      assert.equal(JSON.stringify(lessons.body).includes('P01'), false);
    });

    it('the owner can no longer delete it (other students may be studying it)', async () => {
      const res = await t.call('DELETE', `/api/lessons/${c.lesson}`, as.owner);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'lesson_shared');
    });

    it('someone with no code can read it from the list and by id', async () => {
      const list = await t.call('GET', '/api/lessons', as.none);
      assert.ok(list.body.lessons.some((l) => l.id === c.lesson));
      assert.equal((await t.call('GET', `/api/lessons/${c.lesson}`, as.none)).status, 200);
    });
  });

  describe('coverage (the live router stack)', () => {
    // The old check read the route files with a regular expression, so a route written another way (router.route(),
    // router.all, a router mounted in another file) went unseen. This reads the routes Express will really serve.
    it('every route of the running app is in the tables above, and no router is mounted by hand', () => {
      assert.deepEqual(unclassifiedRoutes(t.app), [], 'add these routes to ROUTES (or LISTS / NOT_LESSON_ROUTES with a reason)');
    });

    it('sees the routes the tables rely on', () => {
      const { routes } = liveRoutes(t.app);
      for (const r of ROUTES) assert.ok(routes.includes(r.name.replace(' /', ' /api/')), `${r.name} is not served by the app`);
      for (const name of [...LISTS, ...NOT_LESSON_ROUTES]) assert.ok(routes.includes(name.replace(' /', ' /api/')), `${name} is not served by the app`);
    });

    describe('proof that it catches a route nobody checked', () => {
      let probe;
      before(async () => {
        probe = await startStudyApp();
      });
      after(() => probe.close());

      it('passes for the real app', () => {
        assert.deepEqual(unclassifiedRoutes(probe.app), []);
      });
      it('fails for a fake unguarded route added to the lessons router', () => {
        const lessons = probe.app.router.stack.find((l) => l.handle?.mountPath === '/api/lessons').handle;
        lessons.get('/:id/leaky', (req, res) => res.json({ raw_text: 'private' }));
        assert.deepEqual(unclassifiedRoutes(probe.app), ['GET /lessons/:id/leaky']);
      });
      it('fails for a route added straight to the app, with a parameter or without', () => {
        probe.app.get('/api/things/:id', (req, res) => res.end());
        probe.app.delete('/api/things', (req, res) => res.end());
        probe.app.route('/api/other/:id').post((req, res) => res.end());
        probe.app.all('/api/anything', (req, res) => res.end());
        const missing = unclassifiedRoutes(probe.app);
        for (const name of ['GET /things/:id', 'DELETE /things', 'POST /other/:id', 'GET /anything', 'POST /anything']) assert.ok(missing.includes(name), `${name} not reported: ${missing}`);
      });
      it('fails for a router mounted by hand, without mount()', async () => {
        const { Router } = await import('express');
        const sneaky = Router();
        sneaky.get('/:id/secret', (req, res) => res.end());
        probe.app.use('/api/sneaky', sneaky);
        assert.ok(unclassifiedRoutes(probe.app).some((m) => /mounted without mount\(\)/.test(m)));
      });
    });

    it('every route under /admin and /settings refuses a request with no PIN (a student code is no help)', async () => {
      const { routes } = liveRoutes(t.app);
      const guarded = routes.map((r) => r.split(' ')).filter(([, full]) => PIN_PREFIXES.some((p) => full.startsWith(`/api${p}/`) || full === `/api${p}`));
      assert.ok(guarded.length >= 15, `only ${guarded.length} admin routes found`);
      const fill = (full) => full.replace(':code', 'P01').replace(':file', 'summary').replace(/:\w+/g, '1');
      for (const [method, full] of guarded) {
        for (const who of [as.none, as.owner]) {
          const res = await t.call(method, fill(full), { ...who, body: ['POST', 'PUT'].includes(method) ? {} : undefined });
          assert.equal(res.status, 401, `${method} ${full} answered ${res.status} without the PIN`);
        }
      }
    });
  });
});
