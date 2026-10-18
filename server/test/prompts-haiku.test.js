import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  distractorsPrompt,
  flashcardsPrompt,
  keyPointsPrompt,
  keyTermsMergePrompt,
  keyTermsPrompt,
  quickCheckReviewPrompt,
  quickChecksPrompt,
  quizReviewPrompt,
  regenerateCardsPrompt,
  sectionsPrompt,
} from '../src/ai/prompts.js';
import { HAIKU_KINDS, haikuRequest, promptKind } from '../src/ai/prompts-haiku.js';
import { promptHash } from '../src/ai/file-ai.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { exportRound, lessonMeta } from '../src/services/claude-exchange.js';

// The Claude (Haiku) writer's own prompt set (ai/prompts-haiku.js): the shared prompts with exact swaps and additions,
// applied only on the lesson:export / lesson:import path.

const LESSON = 'Soil Types\n- Clay holds water well\n- Sand drains quickly\n- Loam mixes both';
const PROMPTS = {
  sections: [sectionsPrompt({ text: LESSON, index: 0, total: 1, summaryLength: 'detailed', minSections: 1, maxSections: 2 }), sectionsPrompt({ text: LESSON, parts: [{ number: 1, text: LESSON }], kind: 'slide', index: 0, total: 1, summaryLength: 'short' })],
  key_points: [keyPointsPrompt({ text: 'Clay holds water.', index: 0, total: 1 }), keyPointsPrompt({ text: 'Clay holds water.', index: 0, total: 2, consolidate: true })],
  key_terms: [keyTermsPrompt({ text: LESSON, index: 0, total: 1, maxTerms: 12 })],
  flashcards: [flashcardsPrompt({ text: LESSON, review: 'Soil review', keyTerms: ['Clay'], index: 0, total: 1, targetCards: 5 }), flashcardsPrompt({ text: LESSON, index: 0, total: 1, targetCards: 5, items: ['Sand drains quickly'] })],
  wrong_answers: [distractorsPrompt({ cards: [{ n: 1, question: 'What does sand do with water?', answer: 'Drains it quickly', evidence: 'Sand drains quickly', words: 3, language: 'en' }], keyTerms: ['Clay'] })],
  quiz_review: [quizReviewPrompt({ items: [{ n: 1, kind: 'concept', question: 'Q?', answer: 'A', true_statement: 'A', evidence: 'A', options: [{ o: 1, text: 'B', use: 'both' }] }], terms: ['Clay', 'Sand'], text: LESSON })],
  quick_check_review: [quickCheckReviewPrompt({ sections: [{ n: 1, title: 'Soil', content: 'Clay holds water.', checks: [{ q: 1, question: 'Q?', answer: 'A', evidence: 'A' }] }], text: LESSON })],
  quick_checks: [quickChecksPrompt({ checks: [{ n: 1, section: 'Soil', content: 'Clay holds water.', question: 'Q?', answer: 'A', evidence: 'A', why: 'vague' }], text: LESSON })],
  rewrite_cards: [regenerateCardsPrompt({ cards: [{ n: 1, kind: 'concept', front: 'Q?', back: 'A', evidence: 'A', problems: ['vague'] }], text: LESSON, others: ['B'] })],
};

describe('the Haiku prompt set', () => {
  it('knows every prompt the pipeline sends and changes each one it covers', () => {
    assert.deepEqual(Object.keys(PROMPTS).sort(), [...HAIKU_KINDS].sort());
    for (const [kind, prompts] of Object.entries(PROMPTS)) {
      for (const p of prompts) {
        assert.equal(promptKind(p.system), kind);
        const h = haikuRequest({ ...p, label: 'x', schema: 'kept' }, LESSON);
        assert.notEqual(h.system, p.system, `${kind}: the system message is unchanged`);
        assert.ok(h.system.startsWith(p.system.slice(0, 40)), `${kind}: it starts from the shared prompt`);
        assert.equal(h.schema, 'kept');
        assert.equal(h.label, 'x');
      }
    }
  });

  it('every swap still finds its anchor in the shared prompts (a missing one throws)', () => {
    for (const prompts of Object.values(PROMPTS)) for (const p of prompts) assert.doesNotThrow(() => haikuRequest(p, LESSON));
    const broken = { ...PROMPTS.flashcards[0], system: PROMPTS.flashcards[0].system.replace('Never ask two cards about the same fact.', 'Never repeat a fact.') };
    assert.throws(() => haikuRequest(broken, LESSON), /no longer contains/);
  });

  it('aims at what lesson 32 got wrong', () => {
    const sys = (kind, i = 0) => haikuRequest(PROMPTS[kind][i], LESSON).system;
    for (const kind of ['sections', 'key_terms', 'flashcards', 'quick_checks', 'rewrite_cards']) assert.match(sys(kind), /read the whole lesson text from the first line to the last/);
    assert.match(sys('flashcards'), /Never "What does X ask\?"/);
    assert.match(sys('flashcards'), /never a heading or title and never a line that only introduces a list/);
    assert.match(sys('flashcards'), /never describe it with synonyms/);
    assert.doesNotMatch(sys('flashcards'), /describe it in plain words with the same meaning/);
    assert.match(sys('flashcards'), /Never go over that number: cards beyond it are cut from the end of the lesson/);
    assert.match(sys('flashcards'), /One question per card/);
    assert.match(sys('key_terms'), /never with a category phrase/);
    assert.match(sys('quiz_review'), /flag it on EVERY card in this batch where it is also right/);
    assert.match(sys('quiz_review'), /would a student who knows the lesson answer "Yes, this is the answer"\?/);
    assert.match(sys('quick_check_review'), /a thing does the asking/);
    assert.match(sys('flashcards'), /which consideration is about how fast the service replies\?" -> "Response time"/);
    assert.match(sys('quiz_review'), /also flag that term's definition where it appears as a yes_no statement on the same card/);
    const wrong = haikuRequest(PROMPTS.wrong_answers[0], LESSON);
    assert.match(wrong.system, /Never a synonym, a narrower or broader name, or a rewording/);
    assert.match(wrong.system, /never the same wrong answer, or the same set, for two cards/);
    assert.match(wrong.system, /must not be the exact correct answer of another card/);
    // the wrong-answer prompt gets the whole lesson, which the shared one never sees
    assert.ok(!PROMPTS.wrong_answers[0].user.includes('<lesson_text>'));
    assert.ok(wrong.user.endsWith(`<lesson_text>\n${LESSON}\n</lesson_text>`));
  });

  it('asks the flashcard writer for the number of cards the pipeline really keeps', () => {
    const p = flashcardsPrompt({ text: LESSON, keyTerms: ['Clay', 'Sand', 'Loam'], index: 0, total: 1, targetCards: 25 });
    assert.match(haikuRequest(p, LESSON).system, /Give about 25 cards/);
    assert.match(haikuRequest(p, LESSON, { maxCards: 30 }).system, /Give about 25 cards/);
    assert.match(haikuRequest(p, LESSON, { maxCards: 20 }).system, /Give about 17 cards/);
    // the list-item call has no count
    const items = haikuRequest(PROMPTS.flashcards[1], LESSON, { maxCards: 20 }).system;
    assert.doesNotMatch(items, /Give about/);
  });

  it('leaves the key-terms merge and any unknown prompt alone', () => {
    const merge = keyTermsMergePrompt({ candidates: [{ term: 'Clay', versions: [{ definition: 'd', evidence: 'e' }] }], maxTerms: 12 });
    assert.equal(promptKind(merge.system), 'key_terms_merge');
    assert.deepEqual(haikuRequest(merge, LESSON), merge);
    const other = { system: 'Some other prompt', user: 'u' };
    assert.deepEqual(haikuRequest(other, LESSON), other);
  });

  it('is used only by the Claude exchange: the Default AI (Gemini) and Gemma keep the shared prompts', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const users = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (p.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('prompts-haiku.js')) users.push(path.relative(src, p).replace(/\\/g, '/'));
      }
    };
    walk(src);
    assert.deepEqual(users.sort(), ['services/claude-exchange.js']);
  });

  it('an export round writes the Haiku prompt and records its hash', async () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const id = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status, origin) VALUES ('Soil', 's.pptx', ?, 20, 'ready', 'admin')").run(LESSON).lastInsertRowid);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-haiku-'));
    try {
      const result = await exportRound({ folder, meta: lessonMeta(db, id, { chunkTokens: 30000, keyTermsMax: 12 }) });
      const first = result.pending[0];
      assert.equal(promptKind(first.system), 'sections');
      assert.match(first.system, /read the whole lesson text from the first line to the last/);
      const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
      assert.equal(manifest[first.name], promptHash(first.system, first.user));
      const doc = fs.readFileSync(path.join(folder, 'prompts', fs.readdirSync(path.join(folder, 'prompts')).find((f) => f.endsWith('.md'))), 'utf8');
      assert.match(doc, /read the whole lesson text from the first line to the last/);
      assert.match(fs.readFileSync(path.join(folder, 'INSTRUCTIONS.md'), 'utf8'), /read raw_text\.txt from the first line to the last/);
    } finally {
      db.close();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
