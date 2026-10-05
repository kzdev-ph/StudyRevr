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

export function sectionsPrompt({ text, index, total, summaryLength, targetSections = 3 }) {
  const system = `${LESSON_RULES}

Task: turn the lesson text into a study review made of bite-sized sections.
- One section per main idea or topic: about ${targetSections} section${targetSections === 1 ? '' : 's'} for the text you get (a few more or fewer is fine, depending on how many distinct ideas it has).
- Skip filler with no study value (cover slide, "Thank you", "Any questions?", page numbers).
- "title": short and specific, at most 8 words.
- "content": ${LENGTH_GUIDE[summaryLength] ?? LENGTH_GUIDE.detailed}. Plain text in short paragraphs; use lines that start with "- " for lists. No markdown headings, no bold or asterisks. Explain it clearly in your own words but stay faithful to the lesson.
- "check_questions": 1 or 2 quick questions that test understanding of that section (why / how / what), each with a short answer (1 or 2 sentences) that the section's content supports.

Reply with this JSON shape:
{"sections":[{"title":"...","content":"...","check_questions":[{"question":"...","answer":"..."}]}]}
If the text has nothing worth studying, reply {"sections":[]}.`;

  return { system, user: `${part(index, total)}${lessonText(text)}` };
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

// maxTerms: how many terms this call may return (the caller trims the merged list to the lesson-wide cap).
export function keyTermsPrompt({ text, index, total, maxTerms }) {
  const system = `${LESSON_RULES}

Task: pick the key terms a student must be able to define on a test.
Include ONLY domain-specific concepts: technical terms, vocabulary and named ideas that this lesson explains or defines. Prefer the broad concept over its examples (define the category, not each item in it).
Do NOT include:
- plain examples or list items: the individual things named to illustrate a concept (each product, brand, tool, device, place or person in a list of examples);
- evaluative or descriptive phrases, such as an advantage, a quality or a trait ("fast", "high quality", "easy to use", "wide reach"), unless the lesson itself defines that phrase as a named concept;
- everyday words, slide or section titles, and anything the lesson does not explain well enough to define.
For each term:
- "term": 1 to 4 words, written as the lesson writes it.
- "definition": 1 or 2 plain sentences that say what the term IS (its meaning, what it does or how it works), using only what the lesson says. Never just list examples, and do not repeat the term as its own definition.
Give at most ${maxTerms} terms, most important first. Fewer is better than weak ones; reply {"terms":[]} if the text defines no real concepts.

Reply with this JSON shape:
{"terms":[{"term":"...","definition":"..."}]}`;
  return { system, user: `${part(index, total)}${lessonText(text)}` };
}
