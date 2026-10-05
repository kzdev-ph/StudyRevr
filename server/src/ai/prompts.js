import { NOTES_LABEL } from './chunk.js';

// Every prompt that receives lesson text starts from these rules (CLAUDE.md: use only the lesson text, and explain
// that a "Notes:" line marks the teacher's spoken explanation of that slide).
const LESSON_RULES = `You help students study from a lesson written by their teacher.

Rules:
1. Use ONLY the lesson text you are given. Never add facts, examples, names, dates or numbers that are not in it, and do not use outside knowledge. If the text does not cover something, leave it out.
2. The lesson text is split into blocks (slides or pages) separated by a blank line. Each line inside a block is one paragraph, one list item ("- item" or "1. item") or one table row ("cell | cell").
3. A line that says exactly "${NOTES_LABEL}" inside a slide block marks the teacher's spoken explanation of that slide. Every line after it in that block is lesson content that elaborates the slide. Treat it as part of that slide's topic, never as a separate topic, and use its explanations when you write about the slide. (A long slide may be cut in two; a piece that starts with "${NOTES_LABEL}" continues the notes of the slide before it.)
4. Write in the language of the lesson text (English, Filipino or Taglish), in simple, clear words a student can follow.
5. Reply with ONE JSON object and nothing else: no markdown, no code fences, no commentary.`;

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
export function sectionsPrompt({ text, parts, kind = 'slide', index, total, summaryLength, targetSections = 3 }) {
  const word = (UNIT_LABEL[kind] ?? UNIT_LABEL.slide).toLowerCase();
  const sourcesRule = parts
    ? `
- "sources": the numbers of the ${word}s this section is written from, as whole numbers in ascending order. Each block of the lesson text starts with a label line such as [${UNIT_LABEL[kind] ?? UNIT_LABEL.slide} 3]; the label is not lesson text, and you take the numbers from those labels. List a ${word} only if the section really uses its content, and never a number that is not on a label in the text you were given.`
    : '';
  const shape = parts
    ? '{"sections":[{"title":"...","content":"...","check_questions":[{"question":"...","answer":"..."}],"sources":[3,4]}]}'
    : '{"sections":[{"title":"...","content":"...","check_questions":[{"question":"...","answer":"..."}]}]}';
  const system = `${LESSON_RULES}

Task: turn the lesson text into a study review made of bite-sized sections.
- One section per main idea or topic: about ${targetSections} section${targetSections === 1 ? '' : 's'} for the text you get (a few more or fewer is fine, depending on how many distinct ideas it has).
- Skip filler with no study value (cover slide, "Thank you", "Any questions?", page numbers).
- "title": short and specific, at most 8 words.
- "content": ${LENGTH_GUIDE[summaryLength] ?? LENGTH_GUIDE.detailed}. Plain text in short paragraphs; use lines that start with "- " for lists. No markdown headings, no bold or asterisks. Explain it clearly in your own words but stay faithful to the lesson.
- "check_questions": 1 or 2 quick questions that test understanding of that section (why / how / what), each with a short answer (1 or 2 sentences) that the section's content supports.${sourcesRule}

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
- Each key point states ONE takeaway: what the student should understand or remember (a definition, a rule, a cause and effect, a comparison, or a conclusion), as one complete sentence of at most 25 words that makes sense on its own.
- A key point is NOT a list of examples. Do not enumerate items or write "such as A, B, C"; if the text gives examples, state the general idea they show. Do not just name a category.
- ${consolidate ? 'Keep the original wording where you can.' : 'Cover the whole text, not just the beginning.'} No duplicates. Do not invent anything.

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
- plain examples or list items: the individual things named to illustrate a concept (each product, brand, tool, device, place or person in a list of examples);
- evaluative or descriptive phrases, such as an advantage, a quality or a trait ("fast", "high quality", "easy to use", "wide reach"), unless the lesson itself defines that phrase as a named concept;
- everyday words, slide or section titles, and anything the lesson does not explain well enough to define. If the lesson only names or titles a term and never says what it means, leave that term out: never define a term from your own knowledge.
For each term:
- "term": 1 to 4 words, written as the lesson writes it.
- "definition": 1 or 2 plain sentences that say what the term IS (its meaning, what it does or how it works), using only what the lesson says. Never just list examples, and do not repeat the term as its own definition.
- "evidence": one sentence or phrase copied EXACTLY, word for word, from the lesson text (at most 25 words) that defines or explains the term. Copy it character for character: do not paraphrase, do not shorten with "...", do not join pieces from different places, and never use a title or heading as evidence. If you cannot find such a quote in the lesson, leave the term out.
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
- "example": one everyday comparison or situation from a student's daily life (1 to 3 sentences) that shows the main idea. It may only illustrate ideas that are in the section: add no new facts, names or numbers about the topic. Write it as plain sentences, with no label like "Example:".

Reply with this JSON shape:
{"simple":"...","example":"..."}`;
  return { system, user: `Section title: ${title}\n<section>\n${content}\n</section>` };
}

// keyTerms: the lesson's key-term names, so the model keeps exactly those words in English.
// checkQuestions: [{ question, answer }]; the reply must give the same number back, in the same order.
export function translatePrompt({ title, content, checkQuestions, keyTerms }) {
  const system = `${REVIEW_RULES}

Task: re-explain this section of a study review in Filipino, the way Filipino students talk: natural Taglish, mixing English words where that is how people say it. Translate the title, the content and each quick-check question and its answer.
- Keep technical terms in English. ${keyTerms.length ? `These are the lesson's key terms; always keep them in English: ${keyTerms.join('; ')}. ` : ''}The first time a technical term appears in a text, write the English term followed by its Filipino meaning in parentheses, for example "hypothesis (hinuha)". After that, use the English term alone.
- Say exactly what the section says: do not add, remove or change any fact, number or name.
- Keep the same layout: short paragraphs, and lines that start with "- " stay list lines. No markdown headings, no bold or asterisks.
- Return the same number of quick-check questions, in the same order.

Reply with this JSON shape:
{"title":"...","content":"...","check_questions":[{"question":"...","answer":"..."}]}`;
  const questions = checkQuestions.map((q, i) => `${i + 1}. Question: ${q.question}\n   Answer: ${q.answer}`).join('\n');
  return { system, user: `Section title: ${title}\n<section>\n${content}\n</section>\nQuick-check questions:\n${questions || '(none)'}` };
}

// Concept flashcards (question -> answer) for one chunk of the lesson. `review` is the part of our study review
// written from this text, as a guide to what matters; the answers and evidence must still come from the lesson text.
// `keyTerms` already have their own term -> definition cards, so the model is told not to repeat them.
export function flashcardsPrompt({ text, review, keyTerms = [], index, total, targetCards }) {
  const system = `${LESSON_RULES}

Task: write flashcards that help a student remember the important ideas of this lesson. A flashcard is a question on the front and a short answer on the back that the student must recall from memory.
- Each card tests ONE idea the lesson explains: a concept, a purpose, a cause and effect, a process step, a characteristic, a rule, or a comparison. Prefer "why", "how" and "what is the difference" questions to yes/no questions.
- "question": one clear question, at most 20 words, that makes sense without seeing the lesson. Do not give the answer away in the question.
- "answer": short enough to recall from memory: at most 25 words, one sentence or a short phrase. Say only what the lesson says.
- "evidence": one sentence or phrase copied EXACTLY, word for word, from the lesson text (at most 25 words) that supports the answer. Copy it character for character: do not paraphrase, do not shorten with "...", do not join pieces from different places, and never use a title or heading as evidence. If you cannot find such a quote, leave the card out.
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
  }
Give about ${targetCards} cards (fewer if the text has fewer ideas worth a card; never pad the list with trivia), in the order the ideas appear in the lesson. Reply {"cards":[]} if the text has nothing worth a card.

Reply with this JSON shape:
{"cards":[{"question":"...","answer":"...","evidence":"..."}]}`;
  const guide = review ? `<review>\n${review}\n</review>\n\n` : '';
  return { system, user: `${part(index, total)}${guide}${lessonText(text)}` };
}
