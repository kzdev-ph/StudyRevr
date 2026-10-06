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

// Answer budgets. The small ones are for Gemma, whose 16K tokens a minute is the tight limit: it gets only the section
// and a capped answer (a section rewrite needs a few hundred tokens).
export const MAX_TOKENS = { simplify: 2000, translate: 4000 };
export const SMALL_MAX_TOKENS = { simplify: 1200, translate: 2000 };

// `call`: options for this one AI call: { config (a provider other than the active one), live, maxTokens }.
export async function simplifySection({ ai, section, call = {} }) {
  const { system, user } = simplifyPrompt(section);
  return ai.generateJSON({
    system,
    user,
    schema: simplifySchema,
    responseSchema: responseSchemas.simplify,
    maxTokens: MAX_TOKENS.simplify,
    label: 'the simpler explanation',
    ...call,
  });
}

// The translation must carry every quick-check question over: a reply with a different count is treated as invalid.
export async function translateSection({ ai, section, keyTerms, call = {} }) {
  const { system, user } = translatePrompt({ ...section, checkQuestions: section.check_questions, keyTerms });
  const schema = translateSchema.refine((v) => v.check_questions.length === section.check_questions.length, {
    message: `check_questions must have exactly ${section.check_questions.length} item(s), in the original order`,
  });
  return ai.generateJSON({ system, user, schema, responseSchema: responseSchemas.translate, maxTokens: MAX_TOKENS.translate, label: 'the Filipino/Taglish version', ...call });
}

// The two rewrites by API name: kind 'simplify' is stored in simple_version, 'translate' in filipino_version.
export const VERSION_COLUMN = { simplify: 'simple_version', translate: 'filipino_version' };

// Makes one rewrite of a section. -> the version object, ready to store as JSON
export function makeVersion({ db, ai, section, kind, call }) {
  if (kind === 'simplify') return simplifySection({ ai, section, call });
  const keyTerms = db.prepare('SELECT term FROM key_terms WHERE lesson_id = ? ORDER BY id').all(section.lesson_id).map((t) => t.term);
  return translateSection({ ai, section, keyTerms, call });
}

export const MADE_BY_COLUMN = { simplify: 'simple_made_by', translate: 'filipino_made_by' };

// Stores a rewrite as the shared version unless one was saved meanwhile (the first one stays), with the provider and
// model that made it. -> true when saved
export function saveSharedVersion(db, sectionId, kind, version, madeBy) {
  const column = VERSION_COLUMN[kind];
  return (
    db
      .prepare(`UPDATE sections SET ${column} = ?, ${MADE_BY_COLUMN[kind]} = ? WHERE id = ? AND ${column} IS NULL`)
      .run(JSON.stringify(version), madeBy?.model ? `${madeBy.provider}/${madeBy.model}` : null, sectionId).changes > 0
  );
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
