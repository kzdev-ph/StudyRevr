import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations } from '../src/db/index.js';
import { cardsNeedingStatements, loadStatements, MAX_ANSWER_WORDS, markStatementReviewed, NOT_IN_REPLY, saveStatements } from '../src/quiz/statement-store.js';
import { quizBuildOptions } from '../src/quiz/options.js';
import { cardHash } from '../src/quiz/review-flags.js';

const TEXT = [
  'A survey is used to collect data from many people. An interview asks one person questions in depth.',
  '- Random Sampling\n- Stratified Sampling\n- Cluster Sampling',
].join('\n\n');
const now = () => new Date('2026-01-01T00:00:00Z');

describe('quiz statement store', () => {
  let db;
  let lessonId;
  const addCard = (front, back, kind = 'concept') =>
    Number(db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, ?, ?, ?, 'a quote', ?)").run(lessonId, kind, front, back, 1).lastInsertRowid);
  const card = (id) => db.prepare('SELECT id, front, back FROM flashcards WHERE id = ?').get(id);
  const row = (id) => db.prepare('SELECT * FROM quiz_statements WHERE flashcard_id = ?').get(id);
  const pair = { trueText: 'A survey collects data from many people.', falseText: 'A survey collects data from one person in depth.' };

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    lessonId = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, status) VALUES ('L', 'l.pptx', ?, 'ready')").run(TEXT).lastInsertRowid);
  });

  it('loads nothing (undefined) from a database without the table, and a Map from one with it', () => {
    assert.ok(loadStatements(db, lessonId) instanceof Map);
    assert.equal(quizBuildOptions(db, lessonId).statements.size, 0);
    db.exec('DROP TABLE quiz_statements');
    assert.equal(loadStatements(db, lessonId), undefined);
    assert.equal(quizBuildOptions(db, lessonId).statements, undefined);
  });

  it('asks for a plain concept card, not a list item, a restating card, a term card or a card with a current row', () => {
    const plain = addCard('What is a survey used for?', 'To collect data from many people.');
    addCard('What is a sampling method?', 'Stratified Sampling');
    addCard('What is a survey of many people?', 'A survey of many people.');
    addCard('Survey', 'Collecting data from many people.', 'term');
    assert.deepEqual(cardsNeedingStatements(db, lessonId).map((c) => c.id), [plain]);

    const done = addCard('What does an interview ask?', 'One person questions in depth.');
    assert.equal(cardsNeedingStatements(db, lessonId).length, 2);
    saveStatements(db, [{ card: card(done), ...pair, status: 'pending' }], now);
    assert.deepEqual(cardsNeedingStatements(db, lessonId).map((c) => c.id), [plain]);
  });

  it('skips a card with a long answer or a question for steps, which stay multiple choice', () => {
    const plain = addCard('What is a survey used for?', 'To collect data from many people.');
    const twelve = 'To collect data from many people and then count what they said'; // 12 words
    assert.equal(twelve.split(' ').length, MAX_ANSWER_WORDS);
    const atLimit = addCard('What does an interview ask?', twelve);
    addCard('What does an interview ask in depth?', `${twelve} again`); // 13 words
    addCard('What are the steps of a survey?', 'Ask questions.');
    addCard('How do you run an interview?', 'Ask one person questions.');
    addCard('Ano ang mga hakbang sa survey?', 'Magtanong.');
    addCard('Paano ginagawa ang interview?', 'Magtanong sa isang tao.');
    assert.deepEqual(cardsNeedingStatements(db, lessonId).map((c) => c.id), [plain, atLimit]);
  });

  it('asks again for a card whose saved row has a stale hash, and returns id, front, back and evidence', () => {
    const id = addCard('What is a survey used for?', 'To collect data from many people.');
    saveStatements(db, [{ card: card(id), ...pair, status: 'pending' }], now);
    assert.equal(cardsNeedingStatements(db, lessonId).length, 0);
    db.prepare('UPDATE flashcards SET back = ? WHERE id = ?').run('To gather data from a crowd.', id);
    assert.deepEqual(cardsNeedingStatements(db, lessonId), [{ id, front: 'What is a survey used for?', back: 'To gather data from a crowd.', evidence: 'a quote' }]);
    assert.equal(loadStatements(db, lessonId).get(id).card_hash === cardHash(card(id)), false, 'the old row is still loaded, with its old hash');
  });

  it('asks again for a card the reply left out, but not for one the code checks rejected or one the review flagged', () => {
    const left = addCard('What is a survey used for?', 'To collect data from many people.');
    const checked = addCard('What does an interview ask?', 'One person questions in depth.');
    const flagged = addCard('Which method asks one person questions?', 'An interview in depth.');
    saveStatements(db, [{ card: card(left), status: 'rejected', why: NOT_IN_REPLY }, { card: card(checked), status: 'rejected', why: 'true statement: no text' }, { card: card(flagged), ...pair, status: 'pending' }], now);
    markStatementReviewed(db, { cardId: flagged, cardHash: cardHash(card(flagged)), ...pair, flagged: true, why: 'x', now });
    assert.equal(row(flagged).status, 'flagged');
    assert.deepEqual(cardsNeedingStatements(db, lessonId).map((c) => c.id), [left]);
    saveStatements(db, [{ card: card(left), ...pair, status: 'pending' }], now);
    assert.deepEqual(cardsNeedingStatements(db, lessonId), [], 'once it has a pair it is settled');
  });

  it('saves a pair with its hash, skips a card that changed or is gone, and replaces an earlier row', () => {
    const [a, b] = [addCard('What is a survey used for?', 'To collect data from many people.'), addCard('What does an interview ask?', 'One person questions in depth.')];
    const sent = [card(a), card(b)];
    db.prepare('UPDATE flashcards SET front = ? WHERE id = ?').run('What else is a survey used for?', b);
    assert.equal(saveStatements(db, [{ card: sent[0], ...pair, status: 'pending' }, { card: sent[1], ...pair, status: 'pending' }], now), 1);
    assert.equal(row(b), undefined);
    assert.deepEqual(
      { hash: row(a).card_hash, t: row(a).true_text, f: row(a).false_text, status: row(a).status },
      { hash: cardHash(sent[0]), t: pair.trueText, f: pair.falseText, status: 'pending' },
    );
    assert.equal(saveStatements(db, [{ card: sent[0], status: 'rejected', why: 'no statement in the reply' }], now), 1);
    assert.deepEqual({ t: row(a).true_text, status: row(a).status, why: row(a).why }, { t: null, status: 'rejected', why: 'no statement in the reply' });
    db.prepare('DELETE FROM flashcards WHERE id = ?').run(a);
    assert.equal(saveStatements(db, [{ card: sent[0], ...pair, status: 'pending' }], now), 0);
  });

  it('marks a pair reviewed only while the same pair is saved', () => {
    const id = addCard('What is a survey used for?', 'To collect data from many people.');
    saveStatements(db, [{ card: card(id), ...pair, status: 'pending' }], now);
    const base = { cardId: id, cardHash: cardHash(card(id)), ...pair, flagged: false, why: null, now };
    assert.equal(markStatementReviewed(db, { ...base, trueText: 'Something else.' }), 0);
    assert.equal(markStatementReviewed(db, { ...base, falseText: 'Something else.' }), 0);
    assert.equal(markStatementReviewed(db, { ...base, cardHash: 'stale' }), 0);
    assert.equal(row(id).status, 'pending');

    assert.equal(markStatementReviewed(db, base), 1);
    assert.deepEqual({ status: row(id).status, reviewed: row(id).reviewed_at }, { status: 'ok', reviewed: '2026-01-01T00:00:00.000Z' });
    assert.equal(markStatementReviewed(db, { ...base, flagged: true, why: 'the true sentence is not in the lesson' }), 1);
    assert.deepEqual({ status: row(id).status, why: row(id).why }, { status: 'flagged', why: 'the true sentence is not in the lesson' });

    saveStatements(db, [{ card: card(id), status: 'rejected', why: 'x' }], now);
    assert.equal(markStatementReviewed(db, base), 0, 'a rejected row is never reviewed');
  });
});
