import { z } from 'zod';
import { HttpError } from '../middleware/errors.js';
import { chunkBlocks } from '../ai/chunk.js';
import { keyPointsPrompt, keyTermsPrompt, sectionsPrompt } from '../ai/prompts.js';

// One AI feature per function, one call per chunk of lesson text ("never one giant call"). Each takes the `ai`
// client ({ generateJSON }) and reports progress as onProgress({ done, total }).

const MAX_PREVIOUS_TITLES = 12;
const MAX_KNOWN_TERMS = 40;
const MAX_KEY_POINTS = 8;
const MAX_KEY_TERMS = 30;

// Models sometimes return a list of lines where a string was asked for, or a bare array instead of {key: [...]}.
const text = z.preprocess((v) => (Array.isArray(v) ? v.map(String).join('\n') : v), z.string().trim().min(1));
const wrapArray = (key, schema) => z.preprocess((v) => (Array.isArray(v) ? { [key]: v } : v), schema);

const sectionsSchema = wrapArray(
  'sections',
  z.object({
    sections: z.array(
      z.object({
        title: z.string().trim().min(1).max(200),
        content: text.pipe(z.string().min(20)),
        // 1-2 quick checks per section; a third is dropped rather than failing the whole reply
        check_questions: z.array(z.object({ question: text, answer: text })).min(1).transform((q) => q.slice(0, 2)),
      }),
    ),
  }),
);
const keyPointsSchema = wrapArray('key_points', z.object({ key_points: z.array(text).min(1) }));
const keyTermsSchema = wrapArray('terms', z.object({ terms: z.array(z.object({ term: text, definition: text })) }));

const partLabel = (what, i, n) => `${what}${n > 1 ? ` (part ${i + 1} of ${n})` : ''}`;
const termKey = (term) => term.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// -> [{ title, content, check_questions: [{ question, answer }] }] in lesson order
export async function generateSections({ ai, chunks, summaryLength = 'detailed', onProgress = () => {} }) {
  const sections = [];
  onProgress({ done: 0, total: chunks.length });
  for (const chunk of chunks) {
    const { system, user } = sectionsPrompt({
      text: chunk.text,
      index: chunk.index,
      total: chunks.length,
      previousTitles: sections.slice(-MAX_PREVIOUS_TITLES).map((s) => s.title),
      summaryLength,
    });
    const out = await ai.generateJSON({
      system,
      user,
      schema: sectionsSchema,
      maxTokens: 4000,
      label: partLabel('the review sections', chunk.index, chunks.length),
    });
    sections.push(...out.sections);
    onProgress({ done: chunk.index + 1, total: chunks.length });
  }
  if (!sections.length) {
    throw new HttpError(422, "The AI couldn't find anything to study in this lesson. The file may have too little text.");
  }
  return sections;
}

// Reads the generated sections (not the raw slides). A long review is condensed in two steps: key points per
// chunk of sections, then one call that merges the candidates.
export async function generateKeyPoints({ ai, sections, chunkTokens, onProgress = () => {} }) {
  const chunks = chunkBlocks(sections.map((s) => `${s.title}\n${s.content}`), { maxTokens: chunkTokens });
  const total = chunks.length + (chunks.length > 1 ? 1 : 0);
  onProgress({ done: 0, total });

  const candidates = [];
  for (const chunk of chunks) {
    const { system, user } = keyPointsPrompt({ text: chunk.text, index: chunk.index, total: chunks.length });
    const out = await ai.generateJSON({
      system,
      user,
      schema: keyPointsSchema,
      maxTokens: 1500,
      label: partLabel('the key points', chunk.index, chunks.length),
    });
    candidates.push(...out.key_points);
    onProgress({ done: chunk.index + 1, total });
  }

  let points = candidates;
  if (chunks.length > 1) {
    const { system, user } = keyPointsPrompt({ text: candidates.map((p, i) => `${i + 1}. ${p}`).join('\n'), consolidate: true });
    ({ key_points: points } = await ai.generateJSON({ system, user, schema: keyPointsSchema, maxTokens: 1500, label: 'the merged key points' }));
    onProgress({ done: total, total });
  }
  return points.slice(0, MAX_KEY_POINTS);
}

// -> [{ term, definition }], de-duplicated across chunks (first definition wins)
export async function generateKeyTerms({ ai, chunks, onProgress = () => {} }) {
  const terms = [];
  const seen = new Set();
  onProgress({ done: 0, total: chunks.length });
  for (const chunk of chunks) {
    const { system, user } = keyTermsPrompt({
      text: chunk.text,
      index: chunk.index,
      total: chunks.length,
      knownTerms: terms.slice(-MAX_KNOWN_TERMS).map((t) => t.term),
    });
    const out = await ai.generateJSON({
      system,
      user,
      schema: keyTermsSchema,
      maxTokens: 2000,
      label: partLabel('the key terms', chunk.index, chunks.length),
    });
    for (const t of out.terms) {
      const key = termKey(t.term);
      if (key && !seen.has(key)) {
        seen.add(key);
        terms.push(t);
      }
    }
    onProgress({ done: chunk.index + 1, total: chunks.length });
  }
  return terms.slice(0, MAX_KEY_TERMS);
}
