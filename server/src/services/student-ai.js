import { z } from 'zod';
import { modelTuning, PRESETS, STUDENT_PROVIDERS } from '../ai/providers.js';
import { getBoolSetting } from './settings.js';

// A participant's own AI key (participant_ai_keys), for the live calls only: Explain simpler and Filipino/Taglish.
// Lesson processing never uses it. The key is never returned or logged; the API shows its last 4 characters.

const STUDENT_TIMEOUT_MS = 25_000; // a student is waiting, as for the other steps; a preset's 300 s suits batch work, not a tap

export const studentKeysAllowed = (db) => getBoolSetting(db, 'allow_student_keys', false);

export const studentKeyBody = z.object({
  provider: z.enum(STUDENT_PROVIDERS),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(8).max(500),
});

export const studentModelsBody = z.object({
  provider: z.enum(STUDENT_PROVIDERS),
  apiKey: z.string().trim().max(500).optional(),
});

export function readStudentKey(db, participantId) {
  return db.prepare('SELECT provider, model, api_key, key_last4, updated_at FROM participant_ai_keys WHERE participant_id = ?').get(participantId) ?? null;
}

// What the Settings screen may see: never the key itself.
export function describeStudentKey(row) {
  if (!row) return null;
  return { provider: row.provider, provider_label: PRESETS[row.provider]?.label ?? row.provider, model: row.model, last4: row.key_last4, updated_at: row.updated_at };
}

export function saveStudentKey(db, participantId, { provider, model, apiKey }, now) {
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO participant_ai_keys (participant_id, provider, model, api_key, key_last4, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (participant_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, api_key = excluded.api_key,
       key_last4 = excluded.key_last4, updated_at = excluded.updated_at`,
  ).run(participantId, provider, model, apiKey, apiKey.slice(-4), at, at);
}

export function deleteStudentKey(db, participantId) {
  db.pragma('secure_delete = ON'); // the key is overwritten in the file, not just unlinked
  return db.prepare('DELETE FROM participant_ai_keys WHERE participant_id = ?').run(participantId).changes > 0;
}

// For after the study: removes every saved student key (admin). -> how many were deleted
export function deleteAllStudentKeys(db) {
  db.pragma('secure_delete = ON'); // the keys are overwritten in the file, not just unlinked
  return db.prepare('DELETE FROM participant_ai_keys').run().changes;
}

// The AI client config for a student's key: the preset's fixed base URL (a student can't point the server elsewhere).
export function studentConfig({ provider, model, apiKey }) {
  const preset = PRESETS[provider];
  const tuning = modelTuning(provider, model);
  return {
    provider,
    label: preset.label,
    baseUrl: preset.baseUrl,
    apiKey,
    model,
    needsKey: true,
    keyEnv: null,
    jsonSchema: preset.jsonSchema,
    temperature: preset.temperature,
    timeoutMs: Math.min(tuning.timeoutMs ?? STUDENT_TIMEOUT_MS, STUDENT_TIMEOUT_MS),
    requestsPerMinute: tuning.requestsPerMinute,
    extraBody: tuning.extraBody,
  };
}

// A used-up quota or balance, as opposed to a per-minute limit. Google's per-minute 429 also mentions "quota" and
// "billing", so only the per-day quota, a zero limit (no free tier for that model) and credit / balance wording count.
const NO_CREDIT = /insufficient[_ ]?(?:quota|balance|credits?)|no credits?|credit balance|PerDay|per[_ ]day|limit: 0\b|Arrearage|out of credits?/i;

// The plain message a student sees for a key test (or model list) that failed.
export function keyProblemMessage(err, providerLabel) {
  const code = err?.code;
  if (code === 'auth') return { code: 'key_rejected', message: 'The key was rejected. Check that you copied all of it.' };
  if (code === 'no_credit' || (code === 'rate_limit' && NO_CREDIT.test(err.body ?? ''))) {
    return { code: 'no_credit', message: 'The key works but has no credit or quota left.' };
  }
  if (code === 'rate_limit') return { code: 'rate_limit', message: 'Too many requests right now. Try again in a minute.' };
  if (code === 'not_found' || code === 'bad_request') return { code: 'model_unavailable', message: 'This model isn’t available with your key.' };
  if (code === 'timeout' || code === 'network') return { code: 'unreachable', message: `Couldn’t reach ${providerLabel}. Check the internet connection.` };
  if (code === 'provider_error') return { code: 'provider_error', message: `${providerLabel} had a problem on its side. Try again in a minute.` };
  if (code === 'invalid_json' || code === 'bad_response') {
    return { code: 'bad_reply', message: 'This model didn’t answer in the expected format. Pick another model.' };
  }
  return { code: 'error', message: 'The key test didn’t work. Try again in a minute.' };
}
