import { z } from 'zod';
import { HttpError } from '../middleware/errors.js';
import { chunkBlocks, isHeadingLike } from '../ai/chunk.js';
import { mapLimit } from '../ai/pool.js';
import { keyPointsPrompt, keyTermsMergePrompt, keyTermsPrompt, sectionsPrompt } from '../ai/prompts.js';
import { checkEvidence, comparable } from './evidence.js';
import { validateSources } from './sources.js';
import { groupTerms } from './terms.js';

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

const checkSchema = z.object({ question: text, answer: text, evidence: z.string().trim().catch('') });
const sectionsSchema = wrapArray(
  'sections',
  z.object({
    sections: z.array(
      z.object({
        title: z.string().trim().min(1).max(200),
        content: text.pipe(z.string().min(20)),
        // 0-2 quick checks per section, each with its lesson quote (checked in code, pipeline/quick-checks.js); a third,
        // or one without a question or answer, is dropped rather than failing the whole reply
        check_questions: z
          .array(z.unknown())
          .catch([])
          .transform((qs) => qs.map((q) => checkSchema.safeParse(q)).filter((r) => r.success).map((r) => r.data).slice(0, 2)),
        // the slide / page numbers the section was written from; checked in code (see sources.js), so anything goes here
        sources: z.array(z.unknown()).catch([]),
      }),
    ),
  }),
);
const keyPointsSchema = wrapArray('key_points', z.object({ key_points: z.array(text).min(1) }));
// A missing or malformed evidence quote becomes '' so that term is dropped (and logged) instead of failing the call.
// The merge call answers with ids of the candidates it keeps (and which version of one), never with new text.
const keyTermsMergeSchema = wrapArray(
  'terms',
  z.object({ terms: z.array(z.object({ id: z.coerce.number().int(), version: z.coerce.number().int().optional() })) }),
);
const keyTermsSchema = wrapArray(
  'terms',
  z.object({ terms: z.array(z.object({ term: text, definition: text, evidence: z.string().trim().catch('') })) }),
);

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
              check_questions: { type: 'array', items: { type: 'object', properties: { question: str, answer: str, evidence: str }, required: ['question', 'answer', 'evidence'] } },
              sources: { type: 'array', items: { type: 'integer' } },
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
      properties: {
        terms: {
          type: 'array',
          items: { type: 'object', properties: { term: str, definition: str, evidence: str }, required: ['term', 'definition', 'evidence'] },
        },
      },
      required: ['terms'],
    },
  },
};

responseSchemas.keyTermsMerge = {
  name: 'key_terms_merge',
  schema: {
    type: 'object',
    properties: { terms: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, version: { type: 'integer' } }, required: ['id'] } } },
    required: ['terms'],
  },
};

const partLabel = (what, i, n) => `${what}${n > 1 ? ` (part ${i + 1} of ${n})` : ''}`;

// Runs one AI call per item with progress that counts finished calls (stragglers after a failure stay silent).
// `extraCalls`: calls the caller makes afterwards, counted in the progress total.
async function runCalls(items, concurrency, onProgress, call, extraCalls = 0) {
  let done = 0;
  const total = items.length + extraCalls;
  onProgress({ done, total });
  return mapLimit(items, concurrency, async (item, i, ctx) => {
    const out = await call(item, i);
    if (!ctx.stopped()) onProgress({ done: ++done, total });
    return out;
  });
}

// Tokens are estimated as chars / 3 and English words average about 6 characters, so words ~ tokens / 2.
export const targetSectionCount = (tokens) => Math.max(1, Math.round(tokens / 2 / WORDS_PER_SECTION));

const MIN_WORDS_PER_SECTION = 80; // the structure never asks for sections shorter than about this much lesson text
const MIN_TOPIC_WORDS = 60; // a topic shorter than this shares a section with its neighbour

// How many sections a chunk gets, from the lesson's own structure: its topics are its slides / pages, or (a Word
// lesson, where every paragraph is a block) its heading-like lines. At least half the topics, so a short deck of
// separate topics is not folded into one section, but never sections of under ~80 words of lesson text; at most one
// per topic. The size-based target (one per ~280 words) stays the floor for long text with few headings.
// -> { min, max }
export function sectionRange(chunk) {
  const words = chunk.tokens / 2;
  const topics = chunk.numbers?.length || chunk.text.split(/\n{2,}/).filter((b) => isHeadingLike(b.trim())).length || 1;
  const bySize = targetSectionCount(chunk.tokens);
  const min = Math.max(bySize, Math.min(Math.ceil(topics / 2), Math.ceil(words / MIN_WORDS_PER_SECTION)));
  const max = Math.max(min, Math.min(topics, Math.ceil(words / MIN_TOPIC_WORDS)));
  return { min, max };
}

// -> [{ title, content, check_questions: [{ question, answer, evidence }], sources }] in lesson order. `sources` is the sorted
// list of slide / page numbers the section was written from, or null when they aren't known: the lesson has no
// numbers (chunks come without `numbers`), or the model named none that survive the check against the lesson's real
// count (`sourceTotal`) and the blocks it was shown. onDrop({ title, dropped }) reports refused numbers.
export async function generateSections({ ai, chunks, sourceKind, sourceTotal, summaryLength = 'detailed', concurrency = 1, onProgress = () => {}, onDrop = () => {} }) {
  const results = await runCalls(chunks, concurrency, onProgress, async (chunk) => {
    const { min, max } = sectionRange(chunk);
    const targetSections = max;
    const { system, user } = sectionsPrompt({ text: chunk.text, parts: chunk.parts, kind: sourceKind, index: chunk.index, total: chunks.length, summaryLength, minSections: min, maxSections: max });
    const out = await ai.generateJSON({
      system,
      user,
      schema: sectionsSchema,
      responseSchema: responseSchemas.sections,
      maxTokens: Math.min(16_000, Math.max(4000, targetSections * 450 + 1000)),
      label: partLabel('the review sections', chunk.index, chunks.length),
    });
    return {
      sections: out.sections.map(({ sources, ...section }) => {
        if (!chunk.numbers) return { ...section, sources: null };
        const checked = validateSources(sources, { allowed: new Set(chunk.numbers), total: sourceTotal });
        if (checked.dropped.length) onDrop({ title: section.title, dropped: checked.dropped });
        return { ...section, sources: checked.numbers };
      }),
    };
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

// -> [{ term, definition, evidence }], at most `maxTerms` per lesson. Each chunk is asked for its best few terms; one
// whose evidence quote isn't found in its chunk's text is dropped (onDrop({ term, reason })). Terms are then
// de-duplicated across chunks (same term ignoring case and plurals). A lesson with several chunks gets one more call
// that keeps the best of the candidates (see keyTermsMergePrompt); it can only choose among them, and the chosen
// evidence is checked against the whole lesson again. onMerge({ before, after, fallback }) reports the term names
// going into and coming out of that call.
export async function generateKeyTerms({ ai, chunks, maxTerms = 12, concurrency = 1, onProgress = () => {}, onDrop = () => {}, onMerge = () => {} }) {
  const merge = chunks.length > 1;
  const perChunk = Math.min(maxTerms, Math.ceil(maxTerms / chunks.length) + 2);
  const lists = await runCalls(
    chunks,
    concurrency,
    onProgress,
    async (chunk) => {
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
      const sourceKey = comparable(chunk.text);
      const grounded = [];
      for (const t of out.terms) {
        const check = checkEvidence({ term: t.term, evidence: t.evidence, sourceKey });
        if (check.ok) grounded.push({ ...t, evidence: check.evidence });
        else onDrop({ term: t.term, reason: check.reason });
      }
      return grounded.slice(0, perChunk);
    },
    merge ? 1 : 0,
  );

  // Best-first across chunks, so a long lesson's later parts aren't crowded out by its first.
  const interleaved = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let rank = 0; rank < longest; rank++) for (const list of lists) if (list[rank]) interleaved.push(list[rank]);
  const groups = groupTerms(interleaved);
  const first = (g) => ({ term: g.term, ...g.versions[0] });
  if (!merge) return groups.slice(0, maxTerms).map(first);

  if (groups.length) {
    const { system, user } = keyTermsMergePrompt({ candidates: groups, maxTerms });
    const out = await ai.generateJSON({
      system,
      user,
      schema: keyTermsMergeSchema,
      responseSchema: responseSchemas.keyTermsMerge,
      maxTokens: 1500,
      label: 'the merged key terms',
    });
    const wholeKey = comparable(chunks.map((c) => c.text).join('\n\n'));
    const picked = new Set();
    const kept = [];
    for (const { id, version } of out.terms) {
      const group = groups[id - 1];
      if (!group || picked.has(id)) continue; // an unknown or repeated id is ignored: the model can only choose
      picked.add(id);
      const v = group.versions[(version ?? 1) - 1] ?? group.versions[0];
      const check = checkEvidence({ term: group.term, evidence: v.evidence, sourceKey: wholeKey });
      if (check.ok) kept.push({ term: group.term, definition: v.definition, evidence: check.evidence });
      else onDrop({ term: group.term, reason: check.reason });
    }
    // A reply that picked nothing usable is more likely a glitch than a lesson with no terms: keep the candidates.
    const fallback = !kept.length;
    const result = (fallback ? groups.map(first) : kept).slice(0, maxTerms);
    onMerge({ before: groups.map((g) => g.term), after: result.map((t) => t.term), fallback });
    onProgress({ done: chunks.length + 1, total: chunks.length + 1 });
    return result;
  }
  onProgress({ done: chunks.length + 1, total: chunks.length + 1 });
  return [];
}
