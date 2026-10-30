import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkLesson } from '../src/ai/chunk.js';
import { generateConceptCards, listItems } from '../src/pipeline/flashcards.js';

const LESSON = [
  'Newton\'s Second Law',
  'The net force on an object equals its mass times its acceleration:',
  'F = ma = 10 N when m = 10 kg and a = 1 m/s².',
].join('\n');

const concept = (question, answer, evidence) => ({ question, answer, evidence });
const fakeAi = (cards) => ({ async generateJSON({ schema }) { return schema.parse({ cards }); } });

async function run(cards) {
  const drops = [];
  const kept = await generateConceptCards({ ai: fakeAi(cards), chunks: chunkLesson(LESSON), target: 4, onDrop: (d) => drops.push(d) });
  return { kept, drops };
}

describe('concept cards: numbers in the answer must be in the quote', () => {
  const quote = 'F = ma = 10 N';

  it('drops an answer with a number its quote does not hold', async () => {
    const { kept, drops } = await run([concept('What force acts on a 10 kg mass at 1 m/s²?', '12 N', quote)]);
    assert.deepEqual(kept, []);
    assert.deepEqual(drops.map((d) => d.reason), ['a number in the answer is not in its quote']);
  });

  it('keeps an answer whose numbers are in its quote, however they are written', async () => {
    const { kept, drops } = await run([
      concept('What force acts on a 10 kg mass at 1 m/s²?', '10 N', quote),
      concept('What is the net force for those values?', '10.0 N', quote),
    ]);
    assert.equal(kept.length, 2);
    assert.deepEqual(drops, []);
  });
});

describe('listItems: pure-math lines', () => {
  it('skips lines with no word of 3 letters, keeps word items', () => {
    const text = '- x = 2\n- F = ma\n- 3.5 m/s\n- Igneous\n- Sedimentary rock';
    assert.deepEqual(listItems(text), ['Igneous', 'Sedimentary rock']);
  });
});
