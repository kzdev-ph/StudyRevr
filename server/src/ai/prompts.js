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

export function sectionsPrompt({ text, index, total, previousTitles, summaryLength }) {
  const system = `${LESSON_RULES}

Task: turn the lesson text into a study review made of bite-sized sections.
- One section per main idea or topic. Usually 2 to 5 sections for the text you get; fewer if it is short or mostly filler.
- Skip filler with no study value (cover slide, "Thank you", "Any questions?", page numbers).
- "title": short and specific, at most 8 words.
- "content": ${LENGTH_GUIDE[summaryLength] ?? LENGTH_GUIDE.detailed}. Plain text in short paragraphs; use lines that start with "- " for lists. No markdown headings, no bold or asterisks. Explain it clearly in your own words but stay faithful to the lesson.
- "check_questions": 1 or 2 quick questions that test understanding of that section (why / how / what), each with a short answer (1 or 2 sentences) that the section's content supports.

Reply with this JSON shape:
{"sections":[{"title":"...","content":"...","check_questions":[{"question":"...","answer":"..."}]}]}
If the text has nothing worth studying, reply {"sections":[]}.`;

  const earlier = previousTitles.length
    ? `Sections already written for earlier parts (do not repeat them; if this text continues one of those topics, write a new section that picks up where it left off):\n${previousTitles.map((t) => `- ${t}`).join('\n')}\n\n`
    : '';
  return { system, user: `${part(index, total)}${earlier}${lessonText(text)}` };
}

export function keyPointsPrompt({ text, index, total, consolidate = false }) {
  const system = `${REVIEW_RULES}

Task: ${
    consolidate
      ? 'you get candidate key points collected from different parts of one lesson. Merge duplicates and choose the 5 to 8 that matter most (fewer if there are fewer distinct ones).'
      : `list the key points of this study review: the most important takeaways a student must remember. Give ${total > 1 ? '3 to 5' : '5 to 8 (3 to 5 if the review is short)'}.`
  }
- Each key point is one complete sentence of at most 30 words that makes sense on its own.
- ${consolidate ? 'Keep the original wording where you can.' : 'Cover the whole text, not just the beginning.'} No duplicates. Do not invent anything.

Reply with this JSON shape:
{"key_points":["...","..."]}`;
  const intro = consolidate ? 'Candidate key points:' : `${total > 1 ? `This is part ${index + 1} of ${total} of the review.\n\n` : ''}Study review:`;
  return { system, user: `${intro}\n<text>\n${text}\n</text>` };
}

export function keyTermsPrompt({ text, index, total, knownTerms }) {
  const system = `${LESSON_RULES}

Task: list the key terms a student should know: technical terms, vocabulary and named concepts that the lesson text explains or defines.
- Only include a term if the lesson text gives enough information to define it.
- "term": short (1 to 4 words), written as the lesson writes it. Skip everyday words, section titles and names of people or places unless the lesson defines them as a concept.
- "definition": 1 or 2 sentences in simple words, based only on what the lesson says.
- Usually 3 to 8 terms for the text you get; none if it defines no terms.

Reply with this JSON shape:
{"terms":[{"term":"...","definition":"..."}]}
If there are no terms, reply {"terms":[]}.`;
  const known = knownTerms.length ? `Terms already found in earlier parts (do not list them again):\n${knownTerms.map((t) => `- ${t}`).join('\n')}\n\n` : '';
  return { system, user: `${part(index, total)}${known}${lessonText(text)}` };
}
