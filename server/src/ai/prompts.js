import { NOTES_LABEL } from './chunk.js';
import { isFormulaOrQuantity, looksMathy } from '../services/math-text.js';

// Every prompt that receives lesson text starts from these rules (CLAUDE.md: use only the lesson text, and explain
// that a "Notes:" line marks the teacher's spoken explanation of that slide).
const LESSON_RULES = `You help students study from a lesson written by their teacher.

Rules:
1. Use ONLY the lesson text you are given. Never add facts, examples, names, dates or numbers that are not in it, and do not use outside knowledge. If the text does not cover something, leave it out.
2. The lesson text is split into blocks (slides or pages) separated by a blank line. Each line inside a block is one paragraph, one list item ("- item" or "1. item") or one table row ("cell | cell").
3. A line that says exactly "${NOTES_LABEL}" inside a slide block marks the teacher's spoken explanation of that slide. Every line after it in that block is lesson content that elaborates the slide. Treat it as part of that slide's topic, never as a separate topic, and use its explanations when you write about the slide. (A long slide may be cut in two; a piece that starts with "${NOTES_LABEL}" continues the notes of the slide before it.)
4. Write in the language of the lesson text (English, Filipino or Taglish), in simple, clear words a student can follow.
5. Reply with ONE JSON object and nothing else: no markdown, no code fences, no commentary.`;

// The lesson's meaning, kept (sections, key points, flashcards and the cards written again): the accuracy check found
// listed items tied together with causes the lesson never states ("because…", "to encourage…") and words that change
// what the lesson means ("workplace readiness" for "professionalism").
export const KEEP_MEANING = `- Keep the lesson's meaning. Never connect things the lesson only lists with a cause, effect or purpose it does not state: write "because", "so that", "to …", "leads to" or "helps … by" only when the lesson itself says it. Listed items stay separate items: if the lesson lists "Share your background, skills, and interests." and "Encourage meaningful communication.", never write "share your background to encourage meaningful communication". Plain synonyms that keep the meaning are fine, but never reword into a new idea ("workplace readiness" adds work to "professionalism"; "fostering confidence" is not "trust").`;

// A question must not ask by place in a list: the accuracy check found "the aim listed first" (it has no single answer
// without counting, and the lesson's order is not something to study). leaks.js `asksByPosition` checks the same in code.
export const NO_POSITION = `Never ask by position in a list ("the aim listed first", "the first purpose", "the second element"): ask by what the item is or does, so the question has one right answer without counting.`;

// Learning objectives, outline and agenda slides say what the lesson will cover, not what it teaches: a question, card
// or key point made from them tests nothing the student learned (accuracy check of lesson 26: "the first learning
// objective"). quiz/list-items.js `isObjectiveBlock` finds those blocks in code and the AI review flags what slips past.
export const NO_OBJECTIVES = `Never make a question, card, key point or term from learning objectives, "at the end of this lesson / students will be able to" lines, an outline or an agenda: they say what the lesson will cover, not what it teaches. Use only the content the lesson explains.`;

// A question that ends in "regarding X" / "related to X" repeats a word of its answer to point at it ("What does the
// data help researchers do regarding decisions?" -> "Make informed decisions"). Ask by what the item means instead.
export const ASK_BY_MEANING = `Tell items of a list apart by what the lesson says each one means or does, in plain words ("Which key element of a self-introduction means being honest and natural?"), never by tacking on "regarding / related to / concerning / in terms of" plus a word of the answer ("…do regarding decisions?" for "Make informed decisions"): that only points at the answer.`;

// Rules for lessons with formulas and worked examples. mathRules adds them only when the text looks mathy, so the
// prompt for any other text stays exactly as it was. The model writes plain Unicode, and mathTextDeep (ai/client.js)
// cleans whatever LaTeX still slips through before the reply is checked.
export const MATH_TEXT = `- Math: write formulas, numbers, units and symbols exactly as the lesson text writes them, as plain text with Unicode symbols (x², v₀, √, π, ×, ÷, ±, ≤, ≥, →, °) and fractions as a/b. Never use LaTeX, dollar signs, backslash commands or markdown.`;
export const MATH_TERMS = `- A term may be the name of a formula or quantity the lesson defines ("Kinetic energy", "Discriminant"); its definition says what it is and may end with the formula as the lesson writes it.`;
export const MATH_CARDS = `- This lesson has formulas or worked examples. Besides concepts, make cards that ask: which formula the lesson gives for a quantity (the answer is the formula as the lesson writes it); what a symbol in a formula stands for and its unit; the next step of a method the lesson shows; and the result of a worked example the lesson itself solves (the question gives the example's values, the answer is the lesson's own result with its unit, and the evidence quote holds that result). Never make up a new problem or new numbers, and never give a result the lesson does not show.`;
export const MATH_OPTIONS = `- When the correct answer is a number with a unit, a formula or an expression, each wrong answer is the same kind of thing in the same format (a number with the same unit; a formula with the same symbols), the result of a common mistake: a wrong operation, a missing square, root or factor, swapped quantities, a wrong unit conversion or a sign error. These wrong answers may use numbers that are not in the lesson (the one exception to rule 1), but must never equal the correct answer in another form (0.5 and 1/2 are the same answer).`;

// The given rules, each on its own line after a line break, or '' when the text is not math.
export function mathRules(text, ...rules) {
  return looksMathy(text) ? `\n${rules.join('\n')}` : '';
}

// The key-points call reads our own generated review, not the teacher's slides, so only the general rules apply.
const REVIEW_RULES = `You help students study from a lesson written by their teacher.

Rules:
1. Use ONLY the text you are given. Never add facts, examples, names, dates or numbers that are not in it, and do not use outside knowledge.
2. Write in the language of the text (English, Filipino or Taglish), in simple, clear words a student can follow.
3. Reply with ONE JSON object and nothing else: no markdown, no code fences, no commentary.`;

const LENGTH_GUIDE = {
  short: 'about 40 to 80 words',
  detailed: 'about 100 to 170 words',
};

const part = (index, total) => (total > 1 ? `This is part ${index + 1} of ${total} of the lesson.\n\n` : '');

const lessonText = (text) => `<lesson_text>\n${text}\n</lesson_text>`;

const UNIT_LABEL = { slide: 'Slide', page: 'Page', paragraph: 'Paragraph' };

// The lesson text with a label line above each block ("[Slide 3]"), so the model can say which slides a section
// used. A block that was cut in two (a long slide) keeps one label: its second piece follows on the next line.
export function labelledText(parts, kind) {
  const word = UNIT_LABEL[kind] ?? UNIT_LABEL.slide;
  let out = '';
  parts.forEach((p, i) => {
    out += i === 0 ? '' : p.number === parts[i - 1].number ? '\n' : '\n\n';
    if (i === 0 || p.number !== parts[i - 1].number) out += `[${word} ${p.number}]\n`;
    out += p.text;
  });
  return out;
}

// `parts` + `kind` (from the chunker, when the lesson records its slide / page numbers) make the model name its
// sources: the numbers of the blocks each section was written from. Without them the text goes in unlabelled.
// `minSections` / `maxSections` (from the lesson's own structure, see sectionRange in generate.js) bound how many
// sections the text gets; without them the model is asked for about `targetSections`.
export function sectionsPrompt({ text, parts, kind = 'slide', index, total, summaryLength, targetSections = 3, minSections = null, maxSections = null }) {
  const word = (UNIT_LABEL[kind] ?? UNIT_LABEL.slide).toLowerCase();
  const sourcesRule = parts
    ? `
- "sources": the numbers of the ${word}s this section is written from, as whole numbers in ascending order. Each block of the lesson text starts with a label line such as [${UNIT_LABEL[kind] ?? UNIT_LABEL.slide} 3]; the label is not lesson text, and you take the numbers from those labels. List a ${word} only if the section really uses its content, and never a number that is not on a label in the text you were given.`
    : '';
  const shape = parts
    ? '{"sections":[{"title":"...","content":"...","check_questions":[{"question":"...","answer":"...","evidence":"..."}],"sources":[3,4]}]}'
    : '{"sections":[{"title":"...","content":"...","check_questions":[{"question":"...","answer":"...","evidence":"..."}]}]}';
  const mathy = mathRules(
    parts ? parts.map((p) => p.text).join('\n') : text,
    MATH_TEXT,
    "- Keep each worked example's steps in order with its numbers and units.",
  );
  const system = `${LESSON_RULES}

Task: turn the lesson text into a study review made of bite-sized sections.
- Follow the lesson's own structure: one section per heading, or per group of neighbouring ${parts ? `${word}s` : 'blocks'} on the same topic, in the lesson's order. A heading that introduces a list (such as "Purpose", "Importance", "Key elements", "Types") is a topic of its own: give it its own section, or share one only with the block right next to it on the same topic. Never fold the whole lesson into one section.
- ${
    minSections && maxSections
      ? minSections === maxSections
        ? `Write ${minSections} section${minSections === 1 ? '' : 's'} for the text you get.`
        : `Write between ${minSections} and ${maxSections} sections for the text you get, as many as it has distinct topics.`
      : `About ${targetSections} section${targetSections === 1 ? '' : 's'} for the text you get (a few more or fewer is fine, depending on how many distinct ideas it has).`
  }
- When the lesson lists items (purposes, elements, types, steps, reasons), the section about that list names every item and what the lesson says about it; leave none out.
- Skip filler with no study value (cover slide, "Thank you", "Any questions?", page numbers).
- "title": short and specific, at most 8 words.
- "content": ${LENGTH_GUIDE[summaryLength] ?? LENGTH_GUIDE.detailed}. Plain text in short paragraphs; use lines that start with "- " for lists. No markdown headings, no bold or asterisks. Explain it clearly in your own words but stay faithful to the lesson.
- "check_questions": 1 or 2 quick questions whose answer this section's lesson text states itself (what it is, what it includes, what it does, how the lesson describes it). Ask "why" or "how does X cause Y" only when the lesson states that reason or way in its own words; never ask for a reason, cause or effect the lesson does not give. Each has a short "answer" (1 or 2 sentences, in the lesson's words) and an "evidence": one sentence or phrase copied EXACTLY, word for word, from the lesson text (at most 40 words, ending where a sentence or clause ends, never in the middle of a phrase) that states the answer. If you cannot find such a quote, leave the question out. ${NO_POSITION}
- ${NO_OBJECTIVES}
${KEEP_MEANING}${sourcesRule}${mathy}

Reply with this JSON shape:
${shape}
If the text has nothing worth studying, reply {"sections":[]}.`;

  return { system, user: `${part(index, total)}${lessonText(parts ? labelledText(parts, kind) : text)}` };
}

export function keyPointsPrompt({ text, index, total, consolidate = false }) {
  const system = `${REVIEW_RULES}

Task: ${
    consolidate
      ? 'you get candidate key points collected from different parts of one lesson. Merge duplicates and choose the 5 to 8 that matter most (fewer if there are fewer distinct ones).'
      : `write the key points of this study review: the takeaways a student must remember. Give ${total > 1 ? '3 to 5' : '5 to 8 (3 to 5 if the review is short)'}.`
  }
- Each key point states ONE takeaway: what the student should understand or remember (a definition, a rule, a cause and effect the text states, a comparison, or a conclusion), as one complete sentence of at most 25 words that makes sense on its own.
- ${NO_OBJECTIVES}
- A key point is NOT a list of examples. Do not enumerate items or write "such as A, B, C"; if the text gives examples, state the general idea they show. Do not just name a category.
- ${consolidate ? 'Keep the original wording where you can.' : 'Cover the whole text, not just the beginning.'} No duplicates. Do not invent anything.
- Never merge two listed items into one point that joins them with a cause or purpose the text does not state ("builds trust to show professionalism"), and keep the text's own key words (never "workplace readiness" for "professionalism").

Reply with this JSON shape:
{"key_points":["...","..."]}`;
  const intro = consolidate ? 'Candidate key points:' : `${total > 1 ? `This is part ${index + 1} of ${total} of the review.

` : ''}Study review:`;
  return { system, user: `${intro}
<text>
${text}
</text>` };
}

// The key terms found in the different parts of one lesson are reviewed together. The model only chooses among the
// candidates (by number) and never writes terms or evidence, so nothing it says can fall outside the lesson.
// candidates: [{ term, versions: [{ definition, evidence }] }]
export function keyTermsMergePrompt({ candidates, maxTerms }) {
  const system = `${REVIEW_RULES}

Task: you get candidate key terms collected from different parts of one lesson. Each candidate has a number, a term, and one or more versions (a definition and the evidence quote it came from). Choose which candidates stay on the lesson's key-terms list.
Keep ONLY domain-specific concepts a student must be able to define on a test: technical terms, vocabulary and named ideas, methods, principles, process steps and classifications that the lesson explains.
Remove a candidate that is:
- a plain example or list item: a particular product, brand, device, publication, platform, place or person named to illustrate a concept;
- an evaluative or descriptive phrase, such as an advantage, a quality or a trait ("wide reach", "high engagement", "limited interactivity", "fast");
- an everyday word, a slide or section title, or something too vague, weak or minor to be asked on a test;
- a definition that only lists examples instead of saying what the term is;
- the same idea as a better candidate (a synonym, a narrower or broader duplicate): keep only the best one.
When a kept term has several versions, choose the version whose definition says best what the term IS and is supported by its evidence.
Keep at most ${maxTerms} candidates, most important first. Keep fewer if the rest are weak. You may ONLY keep, drop and choose among the candidates given: never add a term, never rewrite a definition or an evidence quote, and refer to candidates only by their number.

Reply with this JSON shape (version is the number of the chosen version, 1 if there is only one):
{"terms":[{"id":1,"version":1}]}`;
  const list = candidates
    .map((c, i) => `[${i + 1}] ${c.term}\n${c.versions.map((v, j) => `  version ${j + 1}: definition: ${v.definition}\n    evidence: "${v.evidence}"`).join('\n')}`)
    .join('\n');
  return { system, user: `Candidate key terms:\n<candidates>\n${list}\n</candidates>` };
}

// maxTerms: how many terms this call may return (the caller trims the merged list to the lesson-wide cap).
export function keyTermsPrompt({ text, index, total, maxTerms, targetTerms = maxTerms }) {
  const system = `${LESSON_RULES}

Task: pick the key terms a student must be able to define on a test.
Include ONLY domain-specific concepts: technical terms, vocabulary and named ideas that this lesson explains or defines. A concept is an idea, method, principle, process step or classification that the lesson explains. Named types, approaches, methods, principles and steps ARE concepts, even when the lesson lists several of them and defines each. A concrete thing named as an example of a concept (a particular product, brand, device, publication or platform) is NOT a concept, even if the lesson describes it in one line.
Do NOT include:
- anything that appears only in learning objectives, "at the end of this lesson" lines, an outline or an agenda;
- plain examples or list items: the individual things named to illustrate a concept (each product, brand, tool, device, place or person in a list of examples);
- evaluative or descriptive phrases, such as an advantage, a quality or a trait ("fast", "high quality", "easy to use", "wide reach"), unless the lesson itself defines that phrase as a named concept;
- everyday words, slide or section titles, and anything the lesson does not explain well enough to define. If the lesson only names or titles a term and never says what it means, leave that term out: never define a term from your own knowledge.
For each term:
- "term": 1 to 4 words, written as the lesson writes it.
- "definition": 1 or 2 plain sentences that say what the term IS (its meaning, what it does or how it works), using only what the lesson says. Never just list examples, and never use the term itself or a form of it in the definition (a student is shown the definition and must name the term). Build it from the lesson's own words: add no describing words the lesson does not use (if the lesson says "presented in written form", do not write "created and presented in written form").
- "evidence": one sentence or phrase copied EXACTLY, word for word, from the lesson text (at most 25 words, ending where a sentence or clause ends, never in the middle of a phrase) that defines or explains the term. Copy it character for character: do not paraphrase, do not shorten with "...", do not join pieces from different places, and never use a title or heading as evidence. If you cannot find such a quote in the lesson, leave the term out.${mathRules(text, MATH_TEXT, MATH_TERMS)}
Give about ${targetTerms} terms (at most ${maxTerms}), most important first. Do not stop at the few most basic concepts, but never pad the list with examples or list items just to reach that number: fewer is better than weak ones. Reply {"terms":[]} if the text defines no real concepts.

Reply with this JSON shape:
{"terms":[{"term":"...","definition":"...","evidence":"..."}]}`;
  return { system, user: `${part(index, total)}${lessonText(text)}` };
}

// On-demand rewrites of one finished review section (our own text, not the teacher's slides, so REVIEW_RULES apply).
// The "example" is the one place a student-life comparison is allowed; it may not add facts about the topic.
export function simplifyPrompt({ title, content }) {
  const system = `${REVIEW_RULES}

Task: a student finds this section of a study review hard to follow. Explain it again in a simpler way.
- "simple": the same ideas in short sentences and everyday words, as if explaining to a younger student. Explain any technical word right where you use it, using only what the section says. Keep every main idea. Plain text: put each paragraph and each list item on its own line, separated by line breaks; list items start with "- ". No markdown headings, no bold or asterisks. Not longer than the section.
- "example": one everyday comparison or situation from a student's daily life (1 to 3 sentences) that shows the main idea. It may only illustrate ideas that are in the section: add no new facts, names or numbers about the topic. Write it as plain sentences, with no label like "Example:".${mathRules(content, MATH_TEXT)}

Reply with this JSON shape:
{"simple":"...","example":"..."}`;
  return { system, user: `Section title: ${title}\n<section>\n${content}\n</section>` };
}

// keyTerms: the lesson's key-term names, so the model keeps exactly those words in English.
// checkQuestions: [{ question, answer }]; the reply must give the same number back, in the same order.
export function translatePrompt({ title, content, checkQuestions, keyTerms }) {
  const system = `${REVIEW_RULES}

Task: re-explain this section of a study review in Filipino, the way Filipino students talk: natural Taglish, mixing English words where that is how people say it. Translate the title, the content and each quick-check question and its answer.
- Keep technical terms in English. ${keyTerms.length ? `These are the lesson's key terms: ${keyTerms.join('; ')}. When one of them appears in the section, keep it in English. This list is not something to add: never put a key term into the section where the section does not use it. ` : ''}The first time a technical term appears in a text, write the English term followed by its Filipino meaning in parentheses, for example "hypothesis (hinuha)". After that, use the English term alone.
- Say exactly what the section says: do not add, remove or change any fact, number or name.
- Keep the same layout: short paragraphs, and lines that start with "- " stay list lines. No markdown headings, no bold or asterisks.
- Return the same number of quick-check questions, in the same order.${mathRules(content, MATH_TEXT)}

Reply with this JSON shape:
{"title":"...","content":"...","check_questions":[{"question":"...","answer":"..."}]}`;
  const questions = checkQuestions.map((q, i) => `${i + 1}. Question: ${q.question}\n   Answer: ${q.answer}`).join('\n');
  return { system, user: `Section title: ${title}\n<section>\n${content}\n</section>\nQuick-check questions:\n${questions || '(none)'}` };
}

// Concept flashcards (question -> answer) for one chunk of the lesson. `review` is the part of our study review
// written from this text, as a guide to what matters; the answers and evidence must still come from the lesson text.
// `keyTerms` already have their own term -> definition cards, so the model is told not to repeat them.
// `items` (the coverage follow-up, see flashcards.js): list items of the lesson that no card asks about yet; the reply
// is then one card per item and nothing else.
export function flashcardsPrompt({ text, review, keyTerms = [], index, total, targetCards, items = null }) {
  const system = `${LESSON_RULES}

Task: write flashcards that help a student remember the important ideas of this lesson. A flashcard is a question on the front and a short answer on the back that the student must recall from memory.
- Each card tests ONE idea the lesson explains: a concept, a purpose, a cause and effect the lesson states, a process step, a characteristic, a rule, or a comparison. Ask "what", "which", "how" and "what is the difference" questions, and "why" only when the lesson gives the reason. Never a yes/no question and never an either/or question ("Is it A or B?", "...ba...?", "...o hindi?").
- "question": one clear question, at most 20 words, that makes sense without seeing the lesson. Name the topic in full, the way the lesson does ("a self-introduction", "the key elements of a self-introduction"), never only "it", "this", "the topic" or "your presentation". The question must not give the answer away: it must not contain the answer or its key words, and must not use a word that already means the answer (do not ask "Why is language called dynamic?" when the answer is "because it changes").
- The answer must say something the question does not: never just repeat the question's words as a statement.
- "answer": short enough to recall from memory: at most 25 words, one sentence or a short phrase. Say only what the lesson says, in the lesson's own words: add no describing words it does not use.
${KEEP_MEANING}
- When the lesson lists items under a heading (purposes, importance, key elements, types, steps, reasons), every item gets a card of its own. Ask about that one item through what the lesson says about it ("Which key element of a self-introduction means being honest and natural?" -> "Authentic tone"), naming the list in the question so it has one right answer. When the lesson says nothing more about an item than the item itself, describe it in plain words with the same meaning, never with the item's own words ("Which purpose of a self-introduction is about making others see you well from the start?" -> "Create a positive first impression"). Never ask by position in the list ("the first purpose", "the second element"). ${ASK_BY_MEANING}
- ${NO_OBJECTIVES}
- "evidence": one sentence or phrase copied EXACTLY, word for word, from the lesson text (at most 25 words, ending where a sentence or clause ends, never in the middle of a phrase) that supports the answer. Copy it character for character: do not paraphrase, do not shorten with "...", do not join pieces from different places, and never use a title or heading as evidence. If you cannot find such a quote, leave the card out.
- No trivia: never ask about slide titles, slide or page numbers, the author, the teacher, the school, or the date of the presentation, unless the lesson itself teaches them as content.
- Never ask two cards about the same fact.${
    keyTerms.length
      ? `
- These key terms already have their own "term -> definition" cards: ${keyTerms.join('; ')}. Do not make a card that only asks what one of them means. You may ask how they work, why they matter, or how they differ.`
      : ''
  }${
    review
      ? `
- <review> is a study review written from this lesson text. Use it as a guide to what matters, but take every answer and every evidence quote from <lesson_text>.`
      : ''
  }${mathRules(text, MATH_TEXT, MATH_CARDS)}
${
    items?.length
      ? `These list items of the lesson have no card yet. Write exactly one card for each of them, in this order, and no other cards:\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}`
      : `Give about ${targetCards} cards (fewer if the text has fewer ideas worth a card; never pad the list with trivia), in the order the ideas appear in the lesson. Reply {"cards":[]} if the text has nothing worth a card.`
  }

Reply with this JSON shape:
{"cards":[{"question":"...","answer":"...","evidence":"..."}]}`;
  const guide = review ? `<review>\n${review}\n</review>\n\n` : '';
  return { system, user: `${part(index, total)}${guide}${lessonText(text)}` };
}

// Wrong answer options for multiple-choice quiz questions made from concept flashcards. `cards`: [{ n, question,
// answer, evidence, words?, language?, keep?, rejected?, problems? }], where `evidence` is the verbatim lesson quote the
// card was checked against, `words` the right answer's length and `language` its language ('en' | 'fil'). The
// follow-up call also passes `keep` (wrong answers that passed the checks), `rejected` ([{ text, why }]) and
// `problems` (why the set still gave the answer away). The wrong answers must be believable but wrong according to the
// lesson, and look like the right one so length, wording and tone give nothing away (checked in code: quiz/leaks.js).
export function distractorsPrompt({ cards, keyTerms = [] }) {
  const system = `You help a teacher write a multiple-choice quiz from their lesson.

Rules:
1. Use ONLY the lesson content you are given: each card's question, its correct answer and a quote copied from the lesson. Do not use outside knowledge or add facts, names, dates or numbers that are not in it.
2. A quote may come from the teacher's spoken notes for a slide (written after a line "${NOTES_LABEL}" in the lesson). Treat it as lesson content that explains that slide, not as a separate topic.
3. Write each wrong answer in the language of that card's correct answer (English, Filipino or Taglish).
4. Reply with ONE JSON object and nothing else: no markdown, no code fences, no commentary.

Task: for each card, write 3 wrong answers to its question. A student who has not studied must not be able to pick the right answer from how the options look.
- Each wrong answer must directly answer THIS question and be the same kind of thing it asks for (a time or condition for "Kailan…/When…", a cause for "Bakit…/Why…", a list of the same category for "Anong uri…/What kinds…"), clearly wrong according to the lesson but believable: a related item of the same kind swapped in (another period, another field, another influence, another group, a cause given as the effect).
- Believable means a student who has NOT read the lesson could pick it: a sensible, ordinary answer that sounds as reasonable as the right one. Never a caricature or an extreme ("loudly and formally", "strictly and lengthily", "as long as possible"), and never something the lesson itself recommends or says is true (not even partly: if the lesson says to share relevant details, "share details that interest the audience" is too close to right). If the lesson lists several right items, a wrong answer is never another item from that same list.
- Never use another card's correct answer, copied or reworded, as a wrong answer: it plainly answers that other question, so a student matches it away.
- Stay on the subject of the question: each wrong answer is about the same thing the question asks about, built from the lesson's own ideas. Never switch to an unrelated topic (food, buildings, prices, jobs, population) and never copy the whole question into a wrong answer: either one is ruled out at a glance.
- Same tone and polarity as the correct answer. If the correct answer is a positive statement, every wrong answer is a positive statement too: no negations ("not", "never", "no", "hindi", "wala", "walang"), no opposites, no version that hides, prevents, limits, removes or makes harder what the correct answer says. An option that sounds negative or absurd is ruled out at a glance.
- Never the opposite or mirror image of the correct answer in meaning, even with no negative word: if the correct answer is "Builds confidence", "Creates anxiety" or "Weakens confidence" is wrong (it is the right answer turned around, so it is ruled out at a glance and as a Yes/No statement it is plainly false). A wrong answer is a different idea from the lesson, not the right answer reversed. ${NO_POSITION}
- A wrong answer states a different fact, never the same claim in other words: swapping words for synonyms ("promote" for "advertise", "details" for "information", "report" for "article") or adding "local", "regional", "various" to the right answer's own sentence still says the right answer. Use an idea the lesson says about something else. Never an absolute word the right answer does not use ("every", "all", "entire", "always", "never"), which is ruled out at a glance. ${NO_OBJECTIVES}
- Make each wrong answer similar in length and style to the correct answer: same kind of phrase, same grammar, about the same number of words (each card says how many). If the correct answer is a full sentence, so is each wrong answer; if it is a short phrase or a list, so is each wrong answer.
- If the correct answer starts with or repeats words from the question (such as "Ginagamit ito" or "Because"), let the wrong answers do the same, so the right one is not the only option that echoes the question. Do not start all 3 wrong answers with the same words unless the correct answer starts that way too.
- Never a correct or partly correct answer, never a reworded copy of the correct answer, and the 3 must differ from each other in substance, not just one word.
- No "all of the above", "none of the above", jokes or obviously silly options.${
    cards.some((c) => isFormulaOrQuantity(c.answer)) ? `\n${MATH_TEXT}\n${MATH_OPTIONS}` : ''
  }${
    keyTerms.length ? `\n- The lesson's key terms: ${keyTerms.join('; ')}.` : ''
  }${
    cards.some((c) => c.rejected || c.problems)
      ? `\n- Some cards were asked before and their wrong answers gave the right one away. For those, the card lists the rejected answers and why: write 3 new wrong answers that avoid those problems. The card's "Kept" answers (if any) passed and may be reused.`
      : ''
  }

Reply with this JSON shape, one item per card, using the card's number as "n":
{"items":[{"n":1,"wrong":["...","...","..."]}]}`;
  const languageName = { en: 'English', fil: 'Filipino' };
  const list = cards
    .map((c) => {
      const lines = [`[${c.n}] Question: ${c.question}`, `    Correct answer: ${c.answer}`, `    From the lesson: "${c.evidence ?? ''}"`];
      if (c.words) lines.push(`    Write each wrong answer in about ${c.words} words${languageName[c.language] ? `, in ${languageName[c.language]}` : ''}.`);
      if (c.keep?.length) lines.push(`    Kept: ${c.keep.map((k) => `"${k}"`).join('; ')}`);
      if (c.rejected?.length) lines.push(`    Rejected: ${c.rejected.map((r) => `"${r.text}" (${r.why})`).join('; ')}`);
      if (c.problems?.length) lines.push(`    Problem with the set: ${c.problems.join('; ')}`);
      return lines.join('\n');
    })
    .join('\n');
  return { system, user: `<cards>\n${list}\n</cards>` };
}

// True / False statements for the quiz (services/quiz-statements.js): for each concept card, one TRUE sentence that
// states the card's answer and one FALSE twin that is the same sentence with only the answer's part swapped for another
// idea from the lesson. `cards`: [{ n, question, answer, evidence, language? }] (`language` 'en' | 'fil'); `text`: the
// lesson (or the blocks around the cards' quotes). The replies are checked in code (quiz/statements.js).
export function statementsPrompt({ cards, text }) {
  const system = `${LESSON_RULES}

Task: the quiz asks some flashcards as True or False. The student sees ONE sentence alone and answers True or False. For each card, write one true sentence and one false sentence.
- "true_statement": one plain sentence that states the card's answer as a fact, joining the question's topic and the answer ("What is the purpose of a self-introduction?" + "To share your background" -> "The purpose of a self-introduction is to share your background."). Use only words from the card's question, its answer and its quote, and keep every key word of the answer. Never add a fact, example, cause or describing word the card does not have. Never a question, never "Yes" or "No", never "The answer is ...".
- "false_statement": the SAME sentence with only the answer's part changed so it is false according to the lesson: put in another idea, item or term FROM THE LESSON that does not answer this question. Every other word stays exactly as in the true sentence.
- The false sentence must be clearly false to a student who studied the lesson and believable to one who did not. Never make it false by adding "not", "never", "no", "hindi", "wala" or "walang", or by turning the answer into its opposite ("builds confidence" -> "creates anxiety"). Never add "only", "always", "all", "every" or "lahat". Never use something the lesson says is also true here, not even partly, and never another item of the same list if the sentence would still be true with it.
- Keep the changed part about as long as the part it replaces. Write both sentences in the language of the card's answer.
- The true sentence must be a COMPLETE sentence of at least 5 words, with the question's subject and a verb. Never just the answer, a bare phrase or a formula alone, and never a line copied from the lesson.
- The changed part of the false sentence must be the same KIND of thing as the answer (a number for a number, a direction for a direction, a term for a term, a step for a step) and a believable alternative on the SAME topic taken from the lesson, such as the other value in a pair or a neighbouring term. Never an unrelated term from another topic.
- If a card cannot be written this way, return empty strings for both "true_statement" and "false_statement" instead of forcing it.
${KEEP_MEANING}
- ${NO_OBJECTIVES}
- ${NO_POSITION} ${ASK_BY_MEANING}${mathRules(text, MATH_TEXT)}

Reply with this JSON shape, one item per card, using the card's number as "n":
{"items":[{"n":1,"true_statement":"...","false_statement":"..."}]}`;
  const languageName = { en: 'English', fil: 'Filipino' };
  const list = cards
    .map((c) => {
      const lines = [`[${c.n}] Question: ${c.question}`, `    Answer: ${c.answer}`, `    From the lesson: "${c.evidence ?? ''}"`];
      if (languageName[c.language]) lines.push(`    Write in ${languageName[c.language]}`);
      return lines.join('\n');
    })
    .join('\n');
  return { system, user: `<cards>\n${list}\n</cards>\n\n${lessonText(text)}` };
}

// One flashcard written again because it gives its answer away (admin "Regenerate this card"). `card`: { kind, front,
// back, evidence }; `problems`: why it was flagged (quiz/leaks.js details); `text`: the part of the lesson around its
// evidence quote; `others`: the lesson's other cards' answers, which the new question must not contain. A concept card
// gets a new question, answer and evidence; a term card keeps its term and gets a new definition.
export function regenerateCardPrompt({ card, problems = [], text, others = [] }) {
  const term = card.kind === 'term';
  const system = `${LESSON_RULES}

Task: a flashcard from this lesson gives its own answer away, so a student can answer it without having studied. Write it again.
${
  term
    ? `- It is a term card: the student sees the definition and must name the term "${card.front}". Write a new "definition": 1 or 2 plain sentences that say what the term is, using only what the lesson says. Never use the term itself or a form of any of its words in the definition.`
    : `- "question": one clear question, at most 20 words, about the same idea. It must not contain the answer or its key words, must not use a word that already means the answer, and must not be a yes/no or either/or question. ${NO_POSITION} ${ASK_BY_MEANING}
- "answer": at most 25 words, saying something the question does not; never just the question's words as a statement. Only what the lesson says, in its own words.
- "evidence": one sentence or phrase copied EXACTLY, word for word, from <lesson_text> (at most 25 words, ending where a sentence or clause ends, never in the middle of a phrase) that supports the answer.${
        others.length ? `\n- The question must not contain any of these answers from other cards: ${others.map((o) => `"${o}"`).join('; ')}.` : ''
      }`
}
${KEEP_MEANING}${mathRules(text, MATH_TEXT)}

Reply with this JSON shape:
${term ? '{"definition":"..."}' : '{"question":"...","answer":"...","evidence":"..."}'}`;
  const old = term ? `Term: ${card.front}\nOld definition: ${card.back}` : `Old question: ${card.front}\nOld answer: ${card.back}`;
  return {
    system,
    user: `<card>\n${old}\nFrom the lesson: "${card.evidence ?? ''}"\nWhat gives it away: ${problems.join('; ') || 'the wording'}\n</card>\n\n${lessonText(text)}`,
  };
}

// The AI exam reviewer (services/quiz-review.js): a strict second look at every quiz form a card can be asked in,
// against the lesson. `items`: [{ n, kind 'term'|'concept', question, answer, true_statement, evidence, options:
// [{ o, text, use 'mc'|'yes_no'|'both' }] }]; for a term card the question is its definition and the answer the term.
// `terms` (the first batch only): the lesson's key terms, to group into families.
export function quizReviewPrompt({ items, terms = [], text }) {
  const system = `You are a strict exam reviewer checking quiz items a teacher's app made from a lesson, before students see them.

Rules:
1. Judge ONLY by the lesson text you are given: what it says is true, what it does not say is not in the lesson. Do not use outside knowledge.
2. A line "${NOTES_LABEL}" inside a slide block starts the teacher's spoken explanation of that slide: it is lesson content.
3. Reply with ONE JSON object and nothing else: no markdown, no code fences, no commentary.

Each item is one flashcard and the ways the quiz can ask it: a multiple-choice question (the right answer among wrong options marked "mc") and a Yes/No question ("Is this the answer?") that shows either the right answer (the true statement) or one false statement (marked "yes_no"). For a term card the question is a definition and the answer is the term it defines. Options marked "both" are used both ways.${
    items.some((it) => it.sentence)
      ? `
For some cards the Yes/No question shows one sentence alone (True or False): then the true statement is that sentence, and the "yes_no" option that is a whole sentence is its false version. Flag that false sentence "two_correct" if the lesson makes it true as well, "reversed" if it is the true sentence negated or turned into its opposite, "giveaway" if nobody would believe it; flag the true statement "not_in_lesson" if it says anything the card and the lesson do not.`
      : ''
  }

Flag only real problems; an item with none gets empty lists. Flags:
- "card" (the flashcard itself):
  - "card_reveals": the question already gives its answer away (it contains the answer, or words that mean it).
  - "not_in_lesson": the right answer (or what the question takes for granted) says something the lesson does not say: describing words the lesson does not use that change the meaning, a cause, effect or purpose connecting things the lesson only lists, or a rewording with a new meaning ("workplace readiness" for "professionalism").
  - "off_topic": the card is made from the lesson's learning objectives, "at the end of this lesson" lines, outline or agenda (what the lesson will cover) instead of from what the lesson teaches. This is judged by what the card is about; the quote being in the lesson text does not matter.
  - "vague": the question does not name its topic ("your presentation", "it", "this") or has more than one right answer according to the lesson, or asks by place in a list ("the aim listed first") instead of by what the item is.
- "set" (the multiple-choice question as a whole):
  - "giveaway": someone who has not read the lesson can pick the right answer from how the options look (the only sensible, the only positive, the only detailed or the only long one), or the right answer rules the others out by itself (it says "relevant" or "brief" and they say "all details" or "everything"). The right answer repeating ONE word of the question is allowed: never flag a set for that alone.
- "true_statement" (the right answer shown alone under "Is this the answer?"):
  - "giveaway": plainly right to anyone who has not read the lesson (common sense alone says yes).
  - "not_in_lesson": as for the card.
- "options" (one wrong option or false statement, by its number "o"):
  - "two_correct": it ALSO answers this question correctly according to the lesson: it says the same as the right answer in other words, or the lesson says it fits this question too (a student who picks it is not wrong). For a term card: that term's meaning also fits the definition (a broader term, or a kind of the asked term).
    Judge by meaning, not by words: swapping a verb or a describing word for a synonym ("improves" for "makes", "take longer" for "slow") does not make an option different. Ask: would a student who knows the lesson be wrong to pick this? If not, flag it. Examples (made-up topics):
    - Question: "Which tool records temperature automatically over time?" Right: "Thermograph". Option "Data logger", which the lesson also says records readings automatically over time: two_correct. Option "Barometer" (measures pressure): fine.
    - Question: "How does compost help a garden?" Right: "It makes soil richer for plants". Option "It improves the soil so plants grow better": two_correct, the same benefit reworded.
    - Question: "What is a drawback of cycling to work?" Right: "Trips can be slow and tiring in hot weather". Option "Rides take longer and cost more effort when it is hot": two_correct, the same drawback reworded. Option "Bikes need a place to be parked": fine, a different drawback.
  - "reversed": it is the right answer turned around, negated or given the opposite meaning, even with no negative word ("Creates anxiety" for "Builds confidence"), so it is ruled out at a glance and as a Yes/No statement it is plainly false.
  - "off_topic": the lesson does not cover it at all, so it is ruled out at a glance. An option whose text appears in the lesson (even word for word) is NEVER "off_topic": it is another item of the lesson that does not answer this question, and that is a good wrong option.
  - "giveaway": a silly caricature or extreme that nobody would pick ("all details", "everything", "always", "as long as possible", "loudly and formally").
A good wrong option is another idea, item or term FROM THE LESSON that does not answer this question (another item of the same list, another key term): never flag it as "off_topic" or "two_correct" only because it is in the lesson or about the same subject. A wrong option that only rewords the right answer is "two_correct", not "off_topic".
Give a short "why" (at most 15 words) with every flag.${
    terms.length
      ? `

Also group the lesson's key terms into "families": put terms in one family only when the definition of EACH would also fit EVERY other one in it: synonyms, or a broader and a narrower term whose names don't show it. Two different kinds of one thing are NOT a family ("Written Self-Introduction" and "Oral Self-Introduction" mean clearly different things), and neither are terms that are only about the same subject. Most lessons have no families: then reply "families":[]. Use the terms exactly as written. Key terms: ${terms.map((t) => `"${t}"`).join(', ')}.`
      : ''
  }

Reply with this JSON shape: exactly one entry for EVERY item, by its number "n", also when nothing is wrong with it (then its lists are empty). Do not leave an item out.
{"items":[{"n":1,"card":[{"flag":"vague","why":"..."}],"set":[],"true_statement":[],"options":[{"o":2,"flag":"two_correct","why":"..."}]}]${terms.length ? ',"families":[["term","term"]]' : ''}}`;
  const list = items
    .map((it) => {
      const lines = [
        `[${it.n}] ${it.kind === 'term' ? 'Term card' : 'Concept card'}`,
        `    Question: ${it.question}`,
        `    Right answer: ${it.answer}`,
        `    True statement: ${it.true_statement}`,
        `    From the lesson: "${it.evidence ?? ''}"`,
        ...it.options.map((o) => `    o${o.o} (${o.use}): ${o.text}`),
      ];
      return lines.join('\n');
    })
    .join('\n');
  return { system, user: `<items>\n${list}\n</items>\n\n${lessonText(text)}` };
}

// Several flagged flashcards written again in one call (the AI review's one fix round; services/quiz-review.js).
// `cards`: [{ n, kind, front, back, evidence, problems: [why] }]; `text`: the lesson (or the blocks around the
// cards' quotes); `others`: answers of the lesson's other cards, which a new question must not contain.
export function regenerateCardsPrompt({ cards, text, others = [] }) {
  const system = `${LESSON_RULES}

Task: an exam reviewer flagged these flashcards. Write each one again so the problem is gone.
- A concept card gets a new "question", "answer" and "evidence". The question: one clear question, at most 20 words, about the same idea, naming its topic in full the way the lesson does (never "it", "this" or "your presentation"); it must not contain the answer or its key words, nor be a yes/no or either/or question. ${NO_POSITION} ${ASK_BY_MEANING} The answer: at most 25 words, only what the lesson says, in the lesson's own words. The evidence: one sentence or phrase copied EXACTLY, word for word, from <lesson_text> (at most 25 words, ending where a sentence or clause ends, never in the middle of a phrase) that supports the answer.
- A term card keeps its term and gets a new "definition": 1 or 2 plain sentences built from the lesson's own words, never using the term or a form of its words.
- Change the wording so the problem is really gone: a card that comes back with the same words is not used.
${KEEP_MEANING}${
    others.length ? `\n- A new question must not contain any of these answers from other cards: ${others.map((o) => `"${o}"`).join('; ')}.` : ''
  }${mathRules(text, MATH_TEXT)}

Reply with this JSON shape, one item per card by its number "n" (concept: question, answer, evidence; term: definition):
{"cards":[{"n":1,"question":"...","answer":"...","evidence":"..."},{"n":2,"definition":"..."}]}`;
  const list = cards
    .map((c) =>
      [
        `[${c.n}] ${c.kind === 'term' ? `Term card: ${c.front}` : 'Concept card'}`,
        c.kind === 'term' ? `    Old definition: ${c.back}` : `    Old question: ${c.front}\n    Old answer: ${c.back}`,
        `    From the lesson: "${c.evidence ?? ''}"`,
        `    The reviewer's problem: ${c.problems.join('; ') || 'unclear'}`,
      ].join('\n'),
    )
    .join('\n');
  return { system, user: `<cards>\n${list}\n</cards>\n\n${lessonText(text)}` };
}

// The quick checks under a section, asked for again (pipeline/quick-checks.js): after generation for the checks whose
// quote didn't hold up in code, and in the review's fix round for the checks the reviewer flagged. `checks`: [{ n,
// section, content, question, answer, evidence, why }] (`section` its title, `content` the section text, `why` what
// was wrong); `text`: the lesson.
export function quickChecksPrompt({ checks, text }) {
  const system = `${LESSON_RULES}

Task: each item is a quick-check question under one section of a study review, with what was wrong with it. Write a new question and answer for each, about the same section, so the problem is gone.
- Ask only what the lesson text itself states: what something is, what it includes, what it does, how the lesson describes it. Ask "why" or "how does X cause Y" only when the lesson states that reason in its own words. ${NO_POSITION} ${NO_OBJECTIVES}
- "answer": 1 or 2 short sentences in the lesson's own words, saying only what the "evidence" quote says.
- "evidence": one sentence or phrase copied EXACTLY, word for word, from <lesson_text> (at most 40 words, ending where a sentence or clause ends, never in the middle of a phrase) that states the answer. Neighbouring list lines may be quoted together, in order.
- ${NO_POSITION}
${KEEP_MEANING}${mathRules(text, MATH_TEXT)}
- Change the wording so the problem is really gone: a question that comes back with the same words is not used. If the lesson gives nothing to ask about this section without the problem, reply with an empty "question" for that item.

Reply with this JSON shape, one item per check by its number "n":
{"checks":[{"n":1,"question":"...","answer":"...","evidence":"..."}]}`;
  const list = checks
    .map((c) =>
      [
        `[${c.n}] Section: ${c.section}`,
        `    Section text: ${String(c.content ?? '').replace(/\s*\n\s*/g, ' / ')}`,
        `    Old question: ${c.question}`,
        `    Old answer: ${c.answer}`,
        `    Its quote: "${c.evidence ?? ''}"`,
        `    What was wrong: ${c.why || 'unclear'}`,
      ].join('\n'),
    )
    .join('\n');
  return { system, user: `<checks>\n${list}\n</checks>\n\n${lessonText(text)}` };
}

// The AI exam reviewer's look at the quick checks (services/check-review.js). `sections`: [{ n, title, content,
// checks: [{ q, question, answer, evidence }] }]; `text`: the lesson.
export function quickCheckReviewPrompt({ sections, text }) {
  const system = `You are a strict exam reviewer checking the quick-check questions a teacher's app wrote under each section of a study review, before students see them.

Rules:
1. Judge ONLY by the lesson text you are given: what it says is true, what it does not say is not in the lesson. Do not use outside knowledge.
2. A line "${NOTES_LABEL}" inside a slide block starts the teacher's spoken explanation of that slide: it is lesson content.
3. Reply with ONE JSON object and nothing else: no markdown, no code fences, no commentary.

Flag only real problems, by the check's number "q"; a section with none gets an empty list. Flags:
- "not_in_lesson": the answer (or what the question takes for granted) says something the lesson does not state: a reason, cause, effect or purpose connecting things the lesson only lists ("because it shows professionalism"), describing words the lesson does not use, or a rewording with a new meaning ("workplace readiness" for "professionalism").
- "not_answered": the section's own text does not answer the question, so a student who read the section can't.
- "off_topic": the question is made from the lesson's learning objectives, "at the end of this lesson" lines, outline or agenda instead of from what the lesson teaches.
- "vague": the question has no single answer according to the lesson, or doesn't name its topic ("it", "this"), or asks by place in a list ("the aim listed first") instead of by what the item is.
Give a short "why" (at most 15 words) with every flag.

Reply with this JSON shape, one entry for EVERY section by its number "n" (a section with nothing to flag gets "checks":[]):
{"sections":[{"n":1,"checks":[{"q":2,"flag":"not_in_lesson","why":"..."}]},{"n":2,"checks":[]}]}`;
  const list = sections
    .map((s) =>
      [
        `[${s.n}] Section: ${s.title}`,
        `    Section text: ${String(s.content ?? '').replace(/\s*\n\s*/g, ' / ')}`,
        ...s.checks.map((c) => `    q${c.q}: Question: ${c.question}\n        Answer: ${c.answer}\n        From the lesson: "${c.evidence ?? ''}"`),
      ].join('\n'),
    )
    .join('\n');
  return { system, user: `<sections>\n${list}\n</sections>\n\n${lessonText(text)}` };
}
