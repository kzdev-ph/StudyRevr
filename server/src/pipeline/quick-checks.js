// Quick checks under a section are grounded like flashcards: each comes with a quote from the lesson, and in code the
// quote must be in raw_text and must state the answer. The accuracy check found a quick check that invented a reason
// ("…because it also shows professionalism and builds confidence" for a list that only names both), so an answer
// that gives a reason, or a "why" question, needs a quote that gives one too. A check that fails is asked for again
// once (one call for the whole lesson) and dropped if it still fails: a section may end with no quick check.
import { z } from 'zod';
import { quickChecksPrompt } from '../ai/prompts.js';
import { asksByPosition, wordStems } from '../quiz/leaks.js';
import { checkEvidence, comparable, MAX_CHECK_EVIDENCE_WORDS } from './evidence.js';

export const MAX_CHECKS = 2;
export const RETRY_LABEL = 'the quick checks (second try)';
const SUPPORT_SHARE = 0.5; // of the answer's own words (not the question's) the quote must hold
const MAX_LESSON_CHARS = 32_000;

// Words that state a reason. A plain "to" or "para sa" is too common to count; "para" alone ("para maging…") does.
const REASON = /\b(because|since|so that|in order to|therefore|thus|reasons?|dahil|kasi|sapagkat|upang|para|kaya)\b/i;
// A question that asks for a reason or a cause: "Why…", "Bakit…", "How does X cause / lead to / affect Y?"
const ASKS_REASON = /^\s*(why|bakit)\b|^\s*how\s+(?:does|do|did|can|could|will|would)\b.*\b(?:cause[sd]?|lead(?:s|ing)?|affect(?:s|ed)?|results?(?:\s+in)?)\b/i;

const flat = (text) => new Set(wordStems(text).flat());

// -> { ok: true, check: { question, answer, evidence } } or { ok: false, reason }. `sourceKey` = comparable(raw_text).
export function checkQuickCheck(check, sourceKey) {
  const question = String(check?.question ?? '').trim();
  const answer = String(check?.answer ?? '').trim();
  if (!question || !answer) return { ok: false, reason: 'no question or answer' };
  if (asksByPosition(question)) return { ok: false, reason: 'it asks by place in the list, not by what the item is' };
  // in the lesson first, then the reason rules, then that the quote says more than the question
  const found = checkEvidence({ term: question, evidence: check.evidence, sourceKey, minExplaining: 0, maxWords: MAX_CHECK_EVIDENCE_WORDS });
  if (!found.ok) return { ok: false, reason: found.reason };
  const quote = found.evidence;
  if (ASKS_REASON.test(question) && !REASON.test(quote)) return { ok: false, reason: 'it asks why, and the lesson’s quote gives no reason' };
  if (REASON.test(answer) && !REASON.test(quote)) return { ok: false, reason: 'the answer gives a reason the lesson’s quote doesn’t state' };
  const ev = checkEvidence({ term: question, evidence: check.evidence, sourceKey, minExplaining: 2, maxWords: MAX_CHECK_EVIDENCE_WORDS });
  if (!ev.ok) return { ok: false, reason: ev.reason };
  const asked = flat(question);
  const own = wordStems(answer).filter((forms) => !forms.some((s) => asked.has(s)));
  if (!own.length) return { ok: false, reason: 'the answer only repeats the question' };
  const quoted = flat(quote);
  const held = own.filter((forms) => forms.some((s) => quoted.has(s))).length;
  if (held / own.length < SUPPORT_SHARE) return { ok: false, reason: 'the answer says more than its quote' };
  return { ok: true, check: { question, answer, evidence: quote } };
}

// A check written again that keeps every content word of its question and answer changed nothing: it counts as failed.
const sameWords = (a, b) => {
  const x = new Set(wordStems(a).map((f) => f[0]));
  const y = new Set(wordStems(b).map((f) => f[0]));
  return x.size === y.size && [...x].every((w) => y.has(w));
};
export const unchangedCheck = (old, next) => sameWords(old.question, next.question) && sameWords(old.answer, next.answer);

const retrySchema = z.preprocess(
  (v) => (Array.isArray(v) ? { checks: v } : v),
  z.object({
    checks: z.array(
      z.object({
        n: z.coerce.number().int(),
        question: z.string().trim().catch(''),
        answer: z.string().trim().catch(''),
        evidence: z.string().trim().catch(''),
      }),
    ),
  }),
);
const str = { type: 'string' };
const retryResponse = {
  name: 'quick_checks',
  schema: {
    type: 'object',
    properties: { checks: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, question: str, answer: str, evidence: str }, required: ['n', 'question', 'answer', 'evidence'] } } },
    required: ['checks'],
  },
};

// The checks in `items` ([{ section: { title, content }, check, why }]) asked for again in one call. -> one entry per
// item, the new check or null (none given, unchanged, or still failing; `onDrop({ section, question, reason })`).
// A failed call drops them all and returns { error }.
export async function askAgain({ ai, items, rawText, label, onDrop = () => {} }) {
  if (!items.length) return { checks: [], error: null };
  const sourceKey = comparable(rawText);
  const { system, user } = quickChecksPrompt({
    checks: items.map((it, i) => ({ n: i + 1, section: it.section.title, content: it.section.content, ...it.check, why: it.why })),
    text: String(rawText ?? '').slice(0, MAX_LESSON_CHARS),
  });
  let reply;
  try {
    reply = await ai.generateJSON({ system, user, schema: retrySchema, responseSchema: retryResponse, maxTokens: Math.min(8000, 600 + items.length * 300), label });
  } catch (err) {
    for (const it of items) onDrop({ section: it.section.title, question: it.check.question, reason: `the call failed (${err.message})` });
    return { checks: items.map(() => null), error: err.message };
  }
  const byN = new Map(reply.checks.map((c) => [c.n, c]));
  const checks = items.map((it, i) => {
    const r = byN.get(i + 1);
    const drop = (reason) => (onDrop({ section: it.section.title, question: it.check.question, reason }), null);
    if (!r?.question) return drop('none given');
    if (unchangedCheck(it.check, r)) return drop('came back unchanged');
    const result = checkQuickCheck(r, sourceKey);
    return result.ok ? result.check : drop(result.reason);
  });
  return { checks, error: null };
}

// The sections stage: every check checked against the lesson, the failing ones asked for again once, at most
// MAX_CHECKS kept per section. -> the sections with grounded `check_questions` (never fails the stage).
export async function groundQuickChecks({ ai, sections, rawText, onDrop = () => {} }) {
  const sourceKey = comparable(rawText);
  const failing = [];
  const kept = sections.map((section) =>
    (section.check_questions ?? []).slice(0, MAX_CHECKS).map((check) => {
      const result = checkQuickCheck(check, sourceKey);
      if (result.ok) return result.check;
      failing.push({ section, check: { question: check.question, answer: check.answer, evidence: check.evidence ?? '' }, why: result.reason });
      return { retry: failing.length - 1 };
    }),
  );
  const again = await askAgain({ ai, items: failing, rawText, label: RETRY_LABEL, onDrop });
  return sections.map((section, si) => ({
    ...section,
    check_questions: kept[si].map((c) => ('retry' in c ? again.checks[c.retry] : c)).filter(Boolean),
  }));
}
