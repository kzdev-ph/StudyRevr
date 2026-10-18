// The prompt set for lessons written by Claude (Haiku) through `npm run lesson:export` / `lesson:import`
// (services/claude-exchange.js). It starts from the app's own prompts (ai/prompts.js, which Gemini and Gemma keep
// unchanged) and changes them only for that writer: exact swaps of a line for a better one and lines added after an
// anchor, aimed at what the audit of lesson 32 (RSCH2120, written by Haiku with the shared prompts, 2026-10-18) found:
// a broader term's option flagged two_correct on three sibling cards but not on the fourth (#755), Yes/No false
// statements nobody would pick ("Exam questions." for what research answers, #729), "What does X ask?" questions
// (#751 #753 #754 #756), a header line as the quote (#744), an option that is also right (#750).
//
// Nothing here loosens a code check: the replies still go through the same zod schemas and checks (quiz/leaks.js,
// evidence quotes, the reviews). Every swap throws when its anchor is missing, so an edit to prompts.js can't silently
// drop one (test/prompts-haiku.test.js).

const swap = (text, oldText, newText) => {
  if (!text.includes(oldText)) throw new Error(`Haiku prompts: the shared prompt no longer contains: ${oldText.slice(0, 90)}`);
  return text.replace(oldText, newText);
};
const after = (text, anchor, added) => swap(text, anchor, anchor + added);

// Which shared prompt a request is, from its system message (labels vary with chunks and rounds).
export function promptKind(system) {
  const s = String(system ?? '');
  if (s.includes('Task: turn the lesson text into a study review')) return 'sections';
  if (s.includes('Task: each item is a quick-check question under one section')) return 'quick_checks';
  if (s.includes('strict exam reviewer checking the quick-check questions')) return 'quick_check_review';
  if (s.includes('strict exam reviewer checking quiz items')) return 'quiz_review';
  if (s.includes('candidate key points collected') || s.includes('write the key points of this study review')) return 'key_points';
  if (s.includes('candidate key terms collected')) return 'key_terms_merge';
  if (s.includes('Task: pick the key terms')) return 'key_terms';
  if (s.includes('Task: write flashcards')) return 'flashcards';
  if (s.includes('Task: for each card, write 3 wrong answers')) return 'wrong_answers';
  if (s.includes('Task: an exam reviewer flagged these flashcards')) return 'rewrite_cards';
  return 'other';
}

// For every prompt that writes lesson content.
const READ_FIRST = `

Before you write anything, read the whole lesson text from the first line to the last. Then:
- Cover every detail the lesson teaches, the small ones too: every list item, every definition, every example and every number it teaches (not slide or item numbering such as "01 02 03").
- Write only what the lesson says. Never add a fact, cause, effect, purpose or example of your own, and never fill a gap from what you know.
- Plain words that a Grade 11 student understands at once (plain English for an English lesson). No padding: no sentence that only announces, introduces or sums up ("There are several types of…", "These four work together…", "X is important for several reasons.").`;

// A quote is the line that says it, never a heading (#744 quoted "Helps gather information about:").
const QUOTE_RULE = `
- An "evidence" quote is the lesson line that states or explains the answer, never a heading or title and never a line that only introduces a list (a line ending in ":" such as "Helps gather information about:"). When the answer is the items of a list, quote the item lines themselves (neighbouring lines may be quoted together, in order).`;

// #751 #753 #754 #756: "What does a survey method's response rate ask?" — a lesson line written as a question
// ("Response rate — How likely are participants to respond?") was turned into "what does X ask".
const NO_ASK = `
- Every question is a clear, complete question a student can answer without guessing what is meant. Never "What does X ask?", "What does X ask researchers to check?" or any question where a thing, not a person, does the asking. When the lesson writes an item as a question ("Response time — How fast does the service reply?"), ask what that item is about or looks at, naming where it belongs: "When choosing a delivery service, what does response time look at?" -> "How fast the service replies".`;

const sections = (s) => {
  let t = after(
    s,
    '- Skip filler with no study value (cover slide, "Thank you", "Any questions?", page numbers).',
    `
- A lesson line written as "Name — what it means" stays one list line in "content": "- Name: what it means". Keep every number, example and named item the lesson gives.`,
  );
  t = swap(
    t,
    'If you cannot find such a quote, leave the question out.',
    `If you cannot find such a quote, leave the question out. The quote is the line that states the answer, never a heading or a line ending in ":" that only introduces a list. Never ask "What does X ask?": when the lesson writes an item as a question, ask what the item is about or looks at.`,
  );
  return t + READ_FIRST;
};

const keyPoints = (s) =>
  swap(
    s,
    '- Never merge two listed items into one point',
    '- Every key point says something the review states: never a point that only says a topic is important or that there are several kinds.\n- Never merge two listed items into one point',
  ) +
  `

Plain words that a Grade 11 student understands at once. Add nothing the review does not say.`;

const keyTerms = (s) => {
  let t = swap(
    s,
    '- "definition": 1 or 2 plain sentences that say what the term IS (its meaning, what it does or how it works), using only what the lesson says.',
    `- "definition": 1 or 2 plain sentences that say what the term IS (its meaning, what it does or how it works), using only what the lesson says. Start with what the lesson says about this term itself ("Collects samples once to describe the present state of a lake."), never with a category phrase ("A type of study that…", "A method that…"): the category fits the lesson's other terms too. The definition must fit this term only, so a student can tell it apart from every other term of the lesson.`,
  );
  t = after(
    t,
    '- everyday words, slide or section titles, and anything the lesson does not explain well enough to define.',
    ` Leave out the lesson's overall topic when the lesson's other terms are kinds or parts of it (its definition would fit every one of them, so a student could never tell them apart).`,
  );
  return t + QUOTE_RULE + READ_FIRST;
};

const flashcards = (s) => {
  let t = swap(
    s,
    `When the lesson says nothing more about an item than the item itself, describe it in plain words with the same meaning, never with the item's own words ("Which purpose of a self-introduction is about making others see you well from the start?" -> "Create a positive first impression").`,
    `When the lesson says nothing more about an item than its name, never describe it with synonyms ("regarding suppositions" for "Test hypotheses"): a synonym is only a vocabulary match, and it gives the answer away. Split the item instead: keep its verb or frame in the question and put the rest in the answer ("What does the collected data help researchers test?" -> "Hypotheses").`,
  );
  t = after(
    t,
    '- Never ask two cards about the same fact.',
    `
- When a lesson line is "Name — what it means" ("Durable — lasts for many years"), ask what the named item does or means and answer with the description ("What does durable material do?" -> "Lasts for many years"), never the reverse: a one-word answer only gets synonyms as wrong answers.${NO_ASK}${QUOTE_RULE}
- Cover the whole lesson: every slide that teaches something gets at least one card, also the lists near the end.`,
  );
  return t + READ_FIRST;
};

const wrongAnswers = (s, u, rawText) => {
  let t = swap(
    s,
    "1. Use ONLY the lesson content you are given: each card's question, its correct answer and a quote copied from the lesson.",
    "1. Use ONLY the lesson content you are given: the whole lesson text in <lesson_text>, and each card's question, its correct answer and a quote copied from the lesson.",
  );
  t = after(
    t,
    'No "all of the above", "none of the above", jokes or obviously silly options.',
    `
- Read the whole lesson text first. Build each wrong answer from the lesson's own ideas: what the lesson says about another item of the same kind (another method, type, quality, step or consideration) or about another part of the lesson, written to fit this question. Never an idea the lesson does not contain, and never something plainly outside the subject (for what research answers, "Exam questions" or "Classroom questions" are ruled out at a glance).
- A wrong answer must not be the exact correct answer of another card of the lesson (that is checked in code and the option is dropped): take a different detail, or the same kind of detail about another item.
- Never a synonym, a narrower or broader name, or a rewording of the correct answer ("Their reach" for "Their generalizability"). If a wrong answer would ALSO be true for this question according to the lesson, do not use it.
- Every wrong answer fits the question's grammar and asks for the same kind of thing: if the question asks "What does reliable data produce?", each option is a kind of result.
- Each wrong answer is also shown alone as "Is this the answer?": a student who studied the lesson must be able to say No, and one who did not must find it believable.
- Give every card its own wrong answers: never the same wrong answer, or the same set, for two cards.
- Plain words that a Grade 11 student understands at once.`,
  );
  return { system: t, user: `${u}\n\n<lesson_text>\n${rawText}\n</lesson_text>` };
};

const quizReview = (s) => {
  let t = after(
    s,
    'A wrong option that only rewords the right answer is "two_correct", not "off_topic".',
    `
Be consistent across cards. Check every option of every item on its own, and when an option (or a false statement) is right for one card, flag it on EVERY card in this batch where it is also right. In particular a broader term, or a definition of one, that covers the asked term is "two_correct" on each card it covers: if a lesson says studies of one kind are "fieldwork", the option "Fieldwork" (and "Work done outside the lab.") is two_correct on every card about a study of that kind, never on only some of them. Two different kinds of one thing are not two_correct for each other.
For every option marked "yes_no" or "both", ask: would a student who knows the lesson answer "Yes, this is the answer"? Then it is "two_correct".
An option a student who has not read the lesson would never pick (it is plainly outside the subject, such as "Classroom questions" for what research answers) is "giveaway".
A question where a thing does the asking ("What does X ask?", "What does X ask researchers to check?") is "vague".`,
  );
  return t;
};

const quickCheckReview = (s) =>
  swap(
    s,
    '- "vague": the question has no single answer according to the lesson, or doesn\'t name its topic ("it", "this"),',
    '- "vague": the question has no single answer according to the lesson, or doesn\'t name its topic ("it", "this"), or a thing does the asking ("What does X ask?"),',
  );

const quickChecks = (s) => s + `${NO_ASK}${QUOTE_RULE}` + READ_FIRST;

const rewriteCards = (s) =>
  after(s, '- Change the wording so the problem is really gone: a card that comes back with the same words is not used.', `${NO_ASK}${QUOTE_RULE}`) + READ_FIRST;

const EDIT = {
  sections,
  key_points: keyPoints,
  key_terms: keyTerms,
  flashcards,
  quick_checks: quickChecks,
  quiz_review: quizReview,
  quick_check_review: quickCheckReview,
  rewrite_cards: rewriteCards,
};

// A pipeline request with the Haiku prompt in place of the shared one. `rawText` is the lesson (the wrong-answer
// prompt gets it whole: the shared one sees only each card's quote). Unknown prompts (the key-terms merge, which only
// picks among candidates) pass through unchanged.
export function haikuRequest(request, rawText) {
  const kind = promptKind(request.system);
  if (kind === 'wrong_answers') return { ...request, ...wrongAnswers(request.system, request.user, rawText) };
  const edit = EDIT[kind];
  return edit ? { ...request, system: edit(request.system) } : request;
}

// Every kind the set changes, for the tests.
export const HAIKU_KINDS = [...Object.keys(EDIT), 'wrong_answers'];
