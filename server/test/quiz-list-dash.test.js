// "Name — what it means" lines as list items (Gemini audit 2026-10-18): RSCH2120's "Importance of Data Quality" writes
// its four qualities without bullets ("Reliable — produces consistent results") and "Choosing a Survey Administration
// Method" its four considerations as "- Response rate — Will enough people respond?". Read as lists, a card whose
// answer is one of the names gets the other names as options in code, and an AI option that is another item of the
// card's own list is not "another card's answer" (rule f), when made or when the quiz is built.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations } from '../src/db/index.js';
import { quizCandidates } from '../src/quiz/build.js';
import { checkWrong, ensureDistractors, loadDistractors } from '../src/quiz/distractors.js';
import { lineItem, listGroups, listMates, siblingItems } from '../src/quiz/list-items.js';

const TEXT = `Importance of Data Quality
Accurate — reflects the information being studied
Reliable — produces consistent results
Relevant — directly relates to the research questions
Complete — includes all necessary information

Choosing a Survey Administration Method
- Participant accessibility — Can participants easily access the survey?
- Response rate — Will enough people respond?
- Data quality — Will the answers be honest and complete?
- Time and cost — Is it practical for the study?

Why collect data
- Draw conclusions
- Data Quality Checks
- Response Rate Targets
- Time and Cost Limits

Two lines are no list
Valid — measures what it should
Timely — arrives when needed`;

const quiet = { warn() {}, log() {}, error() {}, info() {} };
const concept = (id, front, back) => ({ id, kind: 'concept', front, back, evidence: back });

describe('"Name — what it means" lines are list items', () => {
  it('the item is the name, bulleted or not; 3 or more lines make a list', () => {
    assert.deepEqual(listGroups(TEXT).slice(0, 2), [
      ['Accurate', 'Reliable', 'Relevant', 'Complete'],
      ['Participant accessibility', 'Response rate', 'Data quality', 'Time and cost'],
    ]);
    assert.equal(listGroups(TEXT).length, 3, 'the two-line block is not a list');
    assert.deepEqual(siblingItems(listGroups(TEXT), 'Reliable'), ['Accurate', 'Relevant', 'Complete']);
    assert.deepEqual(siblingItems(listGroups(TEXT), 'Response rate.'), ['Participant accessibility.', 'Data quality.', 'Time and cost.']);
  });

  it('a sentence with a dash, a long name or an en dash sub-line is not read as a name', () => {
    assert.equal(lineItem('the study — which ran for years — showed this'), null, 'unbulleted and lowercase');
    assert.equal(lineItem('- A name of far more than five words — desc'), 'A name of far more than five words — desc', 'a bullet keeps its whole text');
    assert.equal(lineItem('– explain the answer'), null);
    assert.equal(lineItem('- Plain bullet'), 'Plain bullet');
    assert.equal(lineItem('2. Numbered — with a meaning'), 'Numbered');
  });

  it('a card asking for a name gets the other names as options, in code', () => {
    const cards = [concept(1, 'Which quality of data produces consistent results?', 'Reliable')];
    const distractors = new Map([[1, ['Dependable', 'Consistent', 'Stable']]]);
    const [p] = quizCandidates(cards, { distractors, lessonText: TEXT });
    assert.deepEqual(p.mcClean.sort(), ['Accurate', 'Complete', 'Relevant'], 'the AI synonyms are not used');
  });
});

describe('rule f is waived for another item of the card’s own list', () => {
  // "Draw conclusions" has no sibling of its shape (the others are names), so its wrong answers are AI-made; one of
  // them is another item of its list, which is also card 3's answer.
  const cards = [
    concept(2, 'What do researchers do with collected data at the end of a study?', 'Draw conclusions'),
    concept(3, 'Which target tells whether enough people answered the survey?', 'Response Rate Targets'),
  ];

  it('listMates are every other item of the list, whatever their shape', () => {
    assert.equal(siblingItems(listGroups(TEXT), 'Draw conclusions'), null);
    assert.deepEqual(listMates(listGroups(TEXT), 'Draw conclusions'), ['Data Quality Checks', 'Response Rate Targets', 'Time and Cost Limits']);
    assert.deepEqual(listMates(listGroups(TEXT), 'Not an item'), []);
  });

  it('the quiz builder keeps it as an option; another card’s answer from outside the list is still dropped', () => {
    const outside = concept(4, 'What does reliable data produce?', 'Consistent results');
    const distractors = new Map([[2, ['Response Rate Targets', 'Set research goals', 'Write survey items', 'Consistent results']]]);
    const p = quizCandidates([...cards, outside], { distractors, lessonText: TEXT }).find((x) => x.card.id === 2);
    assert.ok(p.mcClean.includes('Response Rate Targets'));
    assert.ok(!p.mcClean.includes('Consistent results'));
  });

  it('and so do the checks when wrong answers are made', async () => {
    assert.deepEqual(checkWrong(['Response Rate Targets'], 'Draw conclusions', null, ['Response Rate Targets']).clean, [], 'checkWrong itself still applies rule f to what it is given');
    const db = openDb(':memory:');
    runMigrations(db);
    const lessonId = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, status) VALUES ('L', 'l.pptx', ?, 'ready')").run(TEXT).lastInsertRowid);
    const insert = db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, 'concept', ?, ?, ?, ?)");
    const [id] = cards.map((c, i) => Number(insert.run(lessonId, c.front, c.back, c.evidence, i + 1).lastInsertRowid));
    const ai = {
      calls: 0,
      async generateJSON({ schema }) {
        ai.calls += 1;
        return schema.parse({ items: [{ n: 1, wrong: ['Response Rate Targets', 'Set research goals', 'Write survey items'] }] });
      },
    };
    await ensureDistractors({ db, ai, lessonId, log: quiet });
    assert.equal(ai.calls, 1, 'no second try: the set was clean');
    assert.deepEqual(loadDistractors(db, lessonId).get(id), ['Response Rate Targets', 'Set research goals', 'Write survey items']);
  });
});
