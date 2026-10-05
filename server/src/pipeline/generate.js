import { z } from 'zod';
import { HttpError } from '../middleware/errors.js';
import { chunkBlocks } from '../ai/chunk.js';
import { mapLimit } from '../ai/pool.js';
import { keyPointsPrompt, keyTermsPrompt, sectionsPrompt } from '../ai/prompts.js';

// One AI feature per function, one call per chunk of lesson text ("never one giant call"). Each takes the `ai`
// client ({ generateJSON }), runs its chunk calls in parallel (at most `concurrency` at a time) and reports progress
// as onProgress({ done, total }), where `done` counts finished calls. Calls inside a stage don't see each other's
// output, so results are merged afterwards; the stages themselves stay in order (see run.js).

const MAX_KEY_POINTS = 8;
const WORDS_PER_SECTION = 280; // a section covers roughly this much lesson text
const WORDS_PER_TERM = 100; // a lesson has about one key concept per this many words

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

// The same shapes as plain JSON Schema, for providers that enforce response_format (zod still validates the reply).
const str = { type: 'string' };
const responseSchemas = {
  sections: {
    name: 'review_sections',
    schema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: str,
              content: str,
              check_questions: { type: 'array', items: { type: 'object', properties: { question: str, answer: str }, required: ['question', 'answer'] } },
            },
            required: ['title', 'content', 'check_questions'],
          },
        },
      },
      required: ['sections'],
    },
  },
  keyPoints: {
    name: 'key_points',
    schema: { type: 'object', properties: { key_points: { type: 'array', items: str } }, required: ['key_points'] },
  },
  keyTerms: {
    name: 'key_terms',
    schema: {
      type: 'object',
      properties: { terms: { type: 'array', items: { type: 'object', properties: { term: str, definition: str }, required: ['term', 'definition'] } } },
      required: ['terms'],
    },
  },
};

const partLabel = (what, i, n) => `${what}${n > 1 ? ` (part ${i + 1} of ${n})` : ''}`;
const termKey = (term) => term.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Runs one AI call per item with progress that counts finished calls (stragglers after a failure stay silent).
async function runCalls(items, concurrency, onProgress, call) {
  let done = 0;
  onProgress({ done, total: items.length });
  return mapLimit(items, concurrency, async (item, i, ctx) => {
    const out = await call(item, i);
    if (!ctx.stopped()) onProgress({ done: ++done, total: items.length });
    return out;
  });
}

// Tokens are estimated as chars / 3 and English words average about 6 characters, so words ~ tokens / 2.
export const targetSectionCount = (tokens) => Math.max(1, Math.round(tokens / 2 / WORDS_PER_SECTION));

// -> [{ title, content, check_questions: [{ question, answer }] }] in lesson order
export async function generateSections({ ai, chunks, summaryLength = 'detailed', concurrency = 1, onProgress = () => {} }) {
  const results = await runCalls(chunks, concurrency, onProgress, (chunk) => {
    const targetSections = targetSectionCount(chunk.tokens);
    const { system, user } = sectionsPrompt({ text: chunk.text, index: chunk.index, total: chunks.length, summaryLength, targetSections });
    return ai.generateJSON({
      system,
      user,
      schema: sectionsSchema,
      responseSchema: responseSchemas.sections,
      maxTokens: Math.min(16_000, Math.max(4000, targetSections * 450 + 1000)),
      label: partLabel('the review sections', chunk.index, chunks.length),
    });
  });
  const sections = results.flatMap((out) => out.sections);
  if (!sections.length) {
    throw new HttpError(422, "The AI couldn't find anything to study in this lesson. The file may have too little text.");
  }
  return sections;
}

// Reads the generated sections (not the raw slides). A long review is condensed in two steps: key points per
// chunk of sections (in parallel), then one call that merges the candidates.
export async function generateKeyPoints({ ai, sections, chunkTokens, concurrency = 1, onProgress = () => {} }) {
  const chunks = chunkBlocks(sections.map((s) => `${s.title}\n${s.content}`), { maxTokens: chunkTokens });
  const merge = chunks.length > 1;
  const total = chunks.length + (merge ? 1 : 0);

  let done = 0;
  onProgress({ done, total });
  const perChunk = await mapLimit(chunks, concurrency, async (chunk, _i, ctx) => {
    const { system, user } = keyPointsPrompt({ text: chunk.text, index: chunk.index, total: chunks.length });
    const out = await ai.generateJSON({
      system,
      user,
      schema: keyPointsSchema,
      responseSchema: responseSchemas.keyPoints,
      maxTokens: 1500,
      label: partLabel('the key points', chunk.index, chunks.length),
    });
    if (!ctx.stopped()) onProgress({ done: ++done, total });
    return out.key_points;
  });
  const candidates = perChunk.flat();

  let points = candidates;
  if (merge) {
    const { system, user } = keyPointsPrompt({ text: candidates.map((p, i) => `${i + 1}. ${p}`).join('\n'), consolidate: true });
    ({ key_points: points } = await ai.generateJSON({
      system,
      user,
      schema: keyPointsSchema,
      responseSchema: responseSchemas.keyPoints,
      maxTokens: 1500,
      label: 'the merged key points',
    }));
    onProgress({ done: total, total });
  }
  return points.slice(0, MAX_KEY_POINTS);
}

// -> [{ term, definition }], at most `maxTerms` per lesson, de-duplicated across chunks. Each chunk is asked for its
// best few terms; the lists are interleaved best-first so a long lesson's later parts aren't crowded out by its first.
export async function generateKeyTerms({ ai, chunks, maxTerms = 12, concurrency = 1, onProgress = () => {} }) {
  const perChunk = Math.min(maxTerms, Math.ceil(maxTerms / chunks.length) + 2);
  const lists = await runCalls(chunks, concurrency, onProgress, async (chunk) => {
    // roughly one concept per 100 words of lesson text, between 3 and this call's share of the cap
    const targetTerms = Math.min(perChunk, Math.max(3, Math.round(chunk.tokens / 2 / WORDS_PER_TERM)));
    const { system, user } = keyTermsPrompt({ text: chunk.text, index: chunk.index, total: chunks.length, maxTerms: perChunk, targetTerms });
    const out = await ai.generateJSON({
      system,
      user,
      schema: keyTermsSchema,
      responseSchema: responseSchemas.keyTerms,
      maxTokens: 2000,
      label: partLabel('the key terms', chunk.index, chunks.length),
    });
    return out.terms.slice(0, perChunk);
  });

  const terms = [];
  const seen = new Set();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let rank = 0; rank < longest && terms.length < maxTerms; rank++) {
    for (const list of lists) {
      const t = list[rank];
      const key = t && termKey(t.term);
      if (key && !seen.has(key) && terms.length < maxTerms) {
        seen.add(key);
        terms.push(t);
      }
    }
  }
  return terms;
}
