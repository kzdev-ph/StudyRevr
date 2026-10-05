import { z } from 'zod';
import { simplifyPrompt, translatePrompt } from '../ai/prompts.js';

// Rewrites of one section, made on demand and cached in the sections row (the original summary is never touched):
// `simple_version` holds JSON { text, example }; `filipino_version` holds JSON { title, content, check_questions }.

const text = z.preprocess((v) => (Array.isArray(v) ? v.map(String).join('\n') : v), z.string().trim().min(1));

const simplifySchema = z
  .object({ simple: text, example: z.string().trim().catch('') })
  .transform(({ simple, example }) => ({ text: simple, example: example || null }));

const translateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  content: text,
  check_questions: z.array(z.object({ question: text, answer: text })),
});

const str = { type: 'string' };
const responseSchemas = {
  simplify: {
    name: 'simpler_section',
    schema: { type: 'object', properties: { simple: str, example: str }, required: ['simple', 'example'] },
  },
  translate: {
    name: 'taglish_section',
    schema: {
      type: 'object',
      properties: {
        title: str,
        content: str,
        check_questions: { type: 'array', items: { type: 'object', properties: { question: str, answer: str }, required: ['question', 'answer'] } },
      },
      required: ['title', 'content', 'check_questions'],
    },
  },
};

export async function simplifySection({ ai, section }) {
  const { system, user } = simplifyPrompt(section);
  return ai.generateJSON({ system, user, schema: simplifySchema, responseSchema: responseSchemas.simplify, maxTokens: 2000, label: 'the simpler explanation' });
}

// The translation must carry every quick-check question over: a reply with a different count is treated as invalid.
export async function translateSection({ ai, section, keyTerms }) {
  const { system, user } = translatePrompt({ ...section, checkQuestions: section.check_questions, keyTerms });
  const schema = translateSchema.refine((v) => v.check_questions.length === section.check_questions.length, {
    message: `check_questions must have exactly ${section.check_questions.length} item(s), in the original order`,
  });
  return ai.generateJSON({ system, user, schema, responseSchema: responseSchemas.translate, maxTokens: 4000, label: 'the Filipino/Taglish version' });
}

// Stored JSON -> object for the API; null when there is none. A plain-text value (not written by this code) still works.
export function parseSimple(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.text === 'string') return { text: v.text, example: v.example ?? null };
  } catch {
    // plain text
  }
  return { text: raw, example: null };
}

export function parseFilipino(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.content === 'string') return v;
  } catch {
    // plain text
  }
  return { title: null, content: raw, check_questions: [] };
}
