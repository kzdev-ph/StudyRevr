import { createHash } from 'node:crypto';
import { parseJsonReply } from './json.js';
import { issueSummary } from './client.js';

// An `ai` object ({ generateJSON, stats }) whose answers come from files instead of a provider, so the real pipeline
// (pipeline/run.js) can run on text written elsewhere (Claude Code, `npm run lesson:export` / `lesson:import`). It takes
// the same request the HTTP client does and validates the reply with the same zod schema, so everything after it
// (evidence quotes, leak rules, sibling shapes, reviews) runs unchanged.
//
// A call is named by its label (`the review sections` -> `the-review-sections`; the second call with the same label
// gets `-2`), and a reply is the text of replies/<name>.json. A reply is used only when the prompt it was written for
// is still the prompt now (`hashes[name]` is the hash recorded when that prompt was exported): after a reply upstream
// changed, the old downstream replies are stale and are asked for again.
//
// A call without a usable reply (missing, stale, or failing its schema) never returns and never throws: stage code
// such as the quick-check second try or the review fix rounds catches a failed call and carries on without the item,
// which would quietly build a different lesson. The call hangs instead, and `stalled` settles once the pipeline has
// nothing left to do but wait, with `report()` saying what is needed. The pipeline must be started with a concurrency
// that issues all of a stage's calls at once, or the calls after the first hung one would never be seen.

export const slug = (label) =>
  String(label ?? 'call')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'call';

export const promptHash = (system, user) => createHash('sha256').update(String(system)).update('\u0000').update(String(user)).digest('hex').slice(0, 12);

const STALL_MS = 25;

// `replies`: { read(name) -> text | null, hashes: { name: hash } }.
export function createFileAi({ replies }) {
  const seen = new Map();
  const pending = []; // calls that need a reply: { name, label, hash, system, user, responseSchema, schema, stale }
  const invalid = []; // replies that exist but don't fit the schema: { name, label, problem }
  const used = [];
  const stats = { calls: 0 };
  let timer = null;
  let settle;
  const stalled = new Promise((resolve) => (settle = resolve));

  const hang = () => {
    clearTimeout(timer);
    timer = setTimeout(() => settle('stalled'), STALL_MS);
    return new Promise(() => {});
  };

  async function generateJSON({ system, user, schema, responseSchema, label = 'this request' }) {
    const base = slug(label);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const name = n > 1 ? `${base}-${n}` : base;
    const hash = promptHash(system, user);
    const request = { name, label, hash, system, user, responseSchema, schema, stale: false };

    const text = replies.read(name);
    if (text === null) {
      pending.push(request);
      return hang();
    }
    if (replies.hashes[name] !== hash) {
      // written for a prompt that has since changed, or for none that was ever exported
      pending.push({ ...request, stale: true });
      return hang();
    }
    let value;
    try {
      value = parseJsonReply(text);
    } catch (err) {
      invalid.push({ name, label, problem: `it is not valid JSON (${err.message})` });
      return hang();
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      invalid.push({ name, label, problem: `it does not match the required format (${issueSummary(parsed.error)})` });
      return hang();
    }
    stats.calls += 1;
    used.push(name);
    return parsed.data;
  }

  return { generateJSON, stats, stalled, report: () => ({ pending, invalid, used, waiting: pending.length + invalid.length > 0 }), cancel: () => clearTimeout(timer) };
}
