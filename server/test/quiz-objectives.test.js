import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { quizCandidates, usableCount } from '../src/quiz/build.js';
import { isObjectiveBlock, listGroups, onlyInObjectives, sameShape, siblingItems, withoutObjectives } from '../src/quiz/list-items.js';
import { comparable } from '../src/pipeline/evidence.js';
import { checkQuickCheck } from '../src/pipeline/quick-checks.js';
import { listItems, termCards } from '../src/pipeline/flashcards.js';

// Learning objectives, outline and agenda slides say what a lesson will cover, not what it teaches. Nothing is asked
// from them; the heading may come before the list or after it (a pptx that sets the list before its title).
const OBJECTIVES_BEFORE = ['Learning Objectives:', '- Identify new challenges faced by human populations.', '- Describe how societies adapt.', '- Develop a community-based plan of action.'].join('\n');
const OBJECTIVES_AFTER = ['- Identify new challenges faced by human populations.', '- Describe how societies adapt.', '- Develop a community-based plan of action.', 'Learning Objectives'].join('\n');
const OBJECTIVES_SENTENCES = ['Students will be able to explain sampling.', 'Students will be able to compare methods.'].join('\n');
const BODY = ['Sampling', '- Random sampling picks members by chance.', '- Stratified sampling splits the group first.', '- Quota sampling fills fixed numbers.'].join('\n');
const LESSON = [OBJECTIVES_BEFORE, BODY].join('\n\n');

describe('objective blocks', () => {
  it('are found by a short heading before or after the list, or by "Students will be able to" lines', () => {
    assert.ok(isObjectiveBlock(OBJECTIVES_BEFORE));
    assert.ok(isObjectiveBlock(OBJECTIVES_AFTER));
    assert.ok(isObjectiveBlock(OBJECTIVES_SENTENCES));
    assert.ok(isObjectiveBlock('Outline\n- Sampling\n- Surveys'));
    assert.ok(isObjectiveBlock('At the end of this lesson:\n- Define a sample.'));
  });

  it('leave an ordinary slide alone, even one that mentions objectives or a first step', () => {
    assert.ok(!isObjectiveBlock(BODY));
    assert.ok(!isObjectiveBlock('Research objectives are stated in the proposal.\n- Be specific.\n- Be measurable.'));
    assert.ok(!isObjectiveBlock('The first step of the method\n- State the problem.'));
    assert.ok(!isObjectiveBlock('Students will be able to explain sampling.')); // one line is not a block of them
    assert.ok(!isObjectiveBlock(''));
  });

  it('read "At / By the end of" as a heading only when it is about the lesson or says what students will do', () => {
    const list = '\n- Define a sample.\n- Name a method.';
    for (const heading of [
      'At the end of this lesson',
      'By the end of today’s class:',
      'By the end of the session',
      'At the end of the lesson, students will:',
      'By the end of the week, you will:',
      'At the end of week 1 you will',
      'By the end of the course, learners will',
    ]) assert.ok(isObjectiveBlock(heading + list), heading);
    for (const heading of [
      'At the end of the study period',
      'At the end of the experiment',
      'By the end of the survey',
      'At the end of the interview:',
      'By the end of data collection',
    ]) {
      assert.ok(!isObjectiveBlock(heading + list), `${heading} is content`);
      assert.equal(withoutObjectives(heading + list), heading + list);
    }
    // content under it is still found in the lesson, listed and asked about
    assert.deepEqual(listGroups('At the end of the study period\n- Collect the forms.\n- Count the answers.\n- Report the totals.'), [['Collect the forms.', 'Count the answers.', 'Report the totals.']]);
    assert.equal(listItems('At the end of the study period\n- Collect the forms.\n- Count the answers.\n- Report the totals.').length, 3);
  });

  it('are left out of the lesson text, the list groups and the list items', () => {
    assert.equal(withoutObjectives(LESSON), BODY);
    assert.deepEqual(listGroups(LESSON), [['Random sampling picks members by chance.', 'Stratified sampling splits the group first.', 'Quota sampling fills fixed numbers.']]);
    assert.deepEqual(listGroups(OBJECTIVES_BEFORE), []);
    assert.equal(listItems(LESSON).length, 3);
  });

  it('say whether a quote is only in them', () => {
    const full = comparable(LESSON);
    const body = comparable(withoutObjectives(LESSON));
    assert.ok(onlyInObjectives(comparable('Describe how societies adapt.'), full, body));
    assert.ok(!onlyInObjectives(comparable('Random sampling picks members by chance.'), full, body));
    assert.ok(!onlyInObjectives('', full, body));
    // said again in the body: not only in the objectives
    const both = `${OBJECTIVES_BEFORE}\n\nSocieties adapt\nDescribe how societies adapt.`;
    assert.ok(!onlyInObjectives(comparable('Describe how societies adapt.'), comparable(both), comparable(withoutObjectives(both))));
  });
});

describe('objective-only content is dropped where it is made', () => {
  it('a key term whose quote is only in the objectives gets no card', () => {
    const full = comparable(LESSON);
    const body = comparable(withoutObjectives(LESSON));
    const drops = [];
    const cards = termCards(
      [
        { term: 'Community-based plan', definition: 'A plan of action made with a community.', evidence: 'Develop a community-based plan of action' },
        { term: 'Quota sampling', definition: 'Sampling that fills fixed numbers.', evidence: 'Quota sampling fills fixed numbers' },
      ],
      { sourceKey: full, bodyKey: body, onDrop: (d) => drops.push(d) },
    );
    assert.deepEqual(cards.map((c) => c.front), ['Quota sampling']);
    assert.match(drops[0].reason, /only in the learning objectives/);
  });

  it('a quick check whose quote is only in the objectives is refused', () => {
    const full = comparable(LESSON);
    const body = comparable(withoutObjectives(LESSON));
    const check = { question: 'What should students do about societies?', answer: 'Describe how they adapt.', evidence: 'Describe how societies adapt.' };
    const refused = checkQuickCheck(check, full, body);
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /learning objectives/);
    assert.equal(checkQuickCheck(check, full).ok, true, 'without the body key it is grounded as before');
  });
});

describe('the quiz skips cards made from objectives (rule o)', () => {
  const concept = (id, front, back, evidence = back) => ({ id, kind: 'concept', front, back, evidence });
  const cards = [
    concept(1, 'What should students be able to do about societies?', 'Describe how societies adapt.'),
    concept(2, 'How does stratified sampling begin?', 'It splits the group first.', 'Stratified sampling splits the group first.'),
    concept(3, 'What does quota sampling fill?', 'Fixed numbers.', 'Quota sampling fills fixed numbers.'),
  ];
  const distractors = new Map([
    [1, ['Ignore how societies change', 'Memorise a list of societies', 'Name every society alive']],
    [2, ['It picks members by chance.', 'It asks every member twice.', 'It removes the smallest group.']],
    [3, ['Chance selections.', 'Random draws.', 'Equal shares.']],
  ]);

  it('flags the card and never asks it', () => {
    const [objective] = quizCandidates(cards, { distractors, lessonText: LESSON });
    assert.ok(objective.problems.some((p) => p.rule === 'o'), JSON.stringify(objective.problems));
    assert.equal(objective.mcClean.length, 0);
    assert.equal(objective.falseClean.length, 0);
    const withText = usableCount(cards, { distractors, lessonText: LESSON });
    const noText = usableCount(cards, { distractors });
    assert.ok(withText < noText, `${withText} < ${noText}`);
  });

  it('does not use an objective card’s answer as another card’s false statement', () => {
    const lone = [cards[1], concept(9, 'What is it about societies?', 'Describe how societies adapt.')];
    const [p] = quizCandidates(lone, { lessonText: LESSON });
    assert.ok(!p.falsePool.includes('Describe how societies adapt.'));
  });
});

describe('list siblings', () => {
  it('a name is no sibling of a sentence, nor a long item of a short one', () => {
    assert.ok(sameShape('Clear and Concise Language', 'Relevant Information'));
    assert.ok(!sameShape('Clear and Concise Language', 'Makes studies easier to replicate.'));
    assert.ok(!sameShape('Bias', 'Makes studies easier to replicate'));
    assert.ok(sameShape('Builds confidence.', 'Creates a positive first impression.'));
    assert.ok(!sameShape('Test hypotheses.', 'Determine the relationship between two or more variables in a study.'));
  });

  it('a line ending in a colon starts a new list, so a sub-list is not a sibling of the main list', () => {
    const slide = ['Data helps researchers:', '- Test ideas.', '- Find patterns.', '- Check results.', 'It reduces the risk of:', '- Bias.', '- Error.', '- Waste.'].join('\n');
    const groups = listGroups(slide);
    assert.deepEqual(groups, [['Test ideas.', 'Find patterns.', 'Check results.'], ['Bias.', 'Error.', 'Waste.']]);
    assert.deepEqual(siblingItems(groups, 'Bias.'), ['Error.', 'Waste.']);
  });

  it('writes the siblings with the answer’s closing full stop, so the stop never marks the right option', () => {
    const groups = [['Identify the problem', 'Form hypothesis', 'Review literature', 'Design the study']];
    assert.deepEqual(siblingItems(groups, 'Identify the problem.'), ['Form hypothesis.', 'Review literature.', 'Design the study.']);
    assert.deepEqual(siblingItems([['Build trust.', 'Share interests.', 'Meet people.']], 'Build trust'), ['Share interests', 'Meet people']);
    assert.deepEqual(siblingItems(groups, 'Identify the problem'), ['Form hypothesis', 'Review literature', 'Design the study']);
  });

  it('judges the shape on the list’s own item, so a card’s casing does not matter', () => {
    const groups = [['Clear and Concise Language', 'Relevant Information', 'Authentic Tone', 'Unique Value']];
    assert.deepEqual(siblingItems(groups, 'authentic tone'), ['Clear and Concise Language', 'Relevant Information', 'Unique Value']);
  });

  it('is null when no other item of the list has the answer’s shape, so the card keeps its AI wrong answers', () => {
    const groups = [['Bias', 'Error', 'Reduces the risk of mistakes that spread through the whole study']];
    assert.deepEqual(siblingItems(groups, 'Reduces the risk of mistakes that spread through the whole study.'), null);
    assert.deepEqual(siblingItems(groups, 'Bias'), ['Error'], 'a name still has its sibling name');
    assert.equal(siblingItems(groups, 'Not in the list'), null);
  });

  it('a list item with no sibling of its shape is built from its saved wrong answers like any concept card', () => {
    const lessonText = ['Sampling', '- Random Sampling', '- Stratified Sampling', '- Each member of the group is chosen by chance alone.'].join('\n');
    const card = { id: 1, kind: 'concept', front: 'How is a member chosen in the simplest kind of sample?', back: 'Each member of the group is chosen by chance alone.', evidence: 'Each member of the group is chosen by chance alone.' };
    const distractors = new Map([[1, ['Members are picked because the researcher knows them well.', 'Members are split into fixed numbers before anyone is asked.', 'Members who volunteer first are placed in the sample.']]]);
    const [p] = quizCandidates([card], { distractors, lessonText });
    assert.equal(p.mcClean.length, 3, JSON.stringify(p.problems));
    assert.deepEqual([...p.mcClean].sort(), [...distractors.get(1)].sort());
  });
});
