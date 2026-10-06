import { AiError } from '../ai/client.js';
import { DEFAULT_FALLBACK, fallbackNote, OUTAGE, runChain, STUDENT_FALLBACK } from '../ai/live.js';
import { bareModelId, GEMMA_MODEL, modelTuning } from '../ai/providers.js';
import { studyDate } from '../stats/days.js';
import { MADE_BY_COLUMN, makeVersion, parseFilipino, parseSimple, saveSharedVersion, SMALL_MAX_TOKENS, VERSION_COLUMN } from './section-versions.js';
import { resolveAiConfig } from './settings.js';
import { readStudentKey, studentConfig, studentKeysAllowed } from './student-ai.js';

// A live rewrite (Explain simpler / Filipino-Taglish) for one section, made while the student waits:
//   1. the student's own key, when admin allows it and they saved one (not cached: only they see it)
//   2. the admin Default (the shared cached version when there is one; otherwise a new one, cached for everyone)
//   3. Gemma on the admin's Google key (shown, not cached, so the next request tries Default again; one immediate retry
//      on a provider 5xx, which Gemma returns now and then)
// Without a student key, a cached shared version is served without any AI call (the route does that).

// Live calls for the same section and kind share one request (two students tapping at once): one key for the Default
// (its answer is saved for everyone) and one for Gemma (its answer is not saved; sharing only saves tokens).
const inflight = new WeakMap(); // db -> Map(`${source}:${sectionId}:${kind}` -> Promise)

// -> { promise, first }: `first` is true for the caller that started the request, false for one that joined it
function coalesce(db, key, make) {
  if (!inflight.has(db)) inflight.set(db, new Map());
  const running = inflight.get(db);
  const first = !running.has(key);
  if (first) running.set(key, make().finally(() => running.delete(key)));
  return { promise: running.get(key), first };
}

// The Default's answer -> { version, saved }. `saved` is true only for the request that made the version and stored it
// as the shared one. If a version was stored meanwhile (Prepare, another tap), the stored one is returned instead, so
// everyone reads the same text, and `saved` is false; a caller that joined another's request saved nothing either.
async function sharedDefault({ db, ai, section, kind, config }) {
  const { promise, first } = coalesce(db, `default:${section.id}:${kind}`, async () => {
    const version = await makeVersion({ db, ai, section, kind, call: { config, live: true } });
    if (saveSharedVersion(db, section.id, kind, version, config)) return { version, saved: true };
    const raw = db.prepare(`SELECT ${VERSION_COLUMN[kind]} AS v FROM sections WHERE id = ?`).get(section.id)?.v;
    return { version: (kind === 'simplify' ? parseSimple(raw) : parseFilipino(raw)) ?? version, saved: false };
  });
  const made = await promise;
  return first ? made : { ...made, saved: false };
}

// Gemma's answer, shared by callers that tap the same section and kind at once. Never saved.
const sharedGemma = ({ db, section, kind, run }) => coalesce(db, `gemma:${section.id}:${kind}`, run).promise;

// The Gemma step's config: the admin's Google settings (key, base URL) with the Gemma model and its own tuning (its
// timeout and reasoning_effort win over AI_TIMEOUT_SECONDS / AI_EXTRA_BODY, which are meant for the main model).
// null when there is no Google key, or when Default already is that model.
export function gemmaConfig(db, envAi, defaultCfg) {
  if (defaultCfg.provider === 'google' && bareModelId(defaultCfg.model) === GEMMA_MODEL) return null;
  const cfg = resolveAiConfig(db, envAi, { provider: 'google', model: GEMMA_MODEL });
  if (!cfg.apiKey) return null;
  const tuning = modelTuning('google', GEMMA_MODEL);
  return { ...cfg, timeoutMs: tuning.timeoutMs, extraBody: { ...cfg.extraBody, ...tuning.extraBody } };
}

// The chain's steps for this request. `shared` is the cached Default version, if any. A step's `outcome` is filled in
// by run(): `{ saved }` for the Default (true when this request stored the shared version) and `{ fromCache }`.
export function rewriteSteps({ db, ai, envAi, section, kind, participant, shared }) {
  const steps = [];
  const own = participant && studentKeysAllowed(db) ? readStudentKey(db, participant.id) : null;
  if (own) {
    const config = studentConfig({ provider: own.provider, model: own.model, apiKey: own.api_key });
    steps.push({
      source: 'student',
      provider: own.provider,
      model: own.model,
      fallbackOn: STUDENT_FALLBACK,
      run: () => makeVersion({ db, ai, section, kind, call: { config, live: true } }),
    });
  }
  const defaultCfg = resolveAiConfig(db, envAi);
  if (shared) {
    // made_by is "provider/model"; the model part may itself contain slashes (NIM, OpenRouter)
    const [provider, ...model] = String(section[MADE_BY_COLUMN[kind]] ?? '').split('/');
    steps.push({ source: 'default', provider: provider || null, model: model.join('/') || null, fromCache: true, fallbackOn: DEFAULT_FALLBACK, run: async () => shared });
  } else {
    const step = { source: 'default', provider: defaultCfg.provider, model: defaultCfg.model, fallbackOn: DEFAULT_FALLBACK };
    step.run = async () => {
      const { version, saved } = await sharedDefault({ db, ai, section, kind, config: defaultCfg });
      step.saved = saved;
      if (!saved) step.fromCache = true; // the shared version was already there (or made by the request this one joined)
      return version;
    };
    steps.push(step);
  }
  const gemma = gemmaConfig(db, envAi, defaultCfg);
  if (gemma) {
    const step = { source: 'gemma', provider: 'google', model: GEMMA_MODEL, fallbackOn: OUTAGE, retried: [] };
    const ask = () => makeVersion({ db, ai, section, kind, call: { config: gemma, live: true, maxTokens: SMALL_MAX_TOKENS[kind] } });
    // Gemma now and then answers with an instant HTTP 500: one immediate retry for that, not for a timeout (which
    // already cost the whole wait) or anything else. The retry takes a slot from the same request limit.
    const askRetrying = async () => {
      try {
        return await ask();
      } catch (error) {
        if (error?.code !== 'provider_error') throw error;
        step.retried.push('provider_error');
        return ask();
      }
    };
    step.run = () => sharedGemma({ db, section, kind, run: askRetrying });
    steps.push(step);
  }
  return steps;
}

// What a student sees when no step answered: a rate limit says the AI is busy, anything else (an outage, a retired
// model, a rejected key, an unusable reply) is the same plain "try again". A student can't fix any of those, so the
// message never mentions Settings or the provider's own wording; the real reason is in ai_calls.error_code and
// fallback_reasons, which admin sees (services/ai-problems.js).
function finalError(error) {
  if (error?.code === 'rate_limit') return new AiError('ai_busy', 'The AI is busy, try again in a minute.', 503);
  return new AiError('ai_unavailable', 'The AI couldn’t answer right now. Try again in a minute.', 503);
}

export function logAiCall(db, row, { now, config }) {
  db.prepare(
    `INSERT INTO ai_calls (participant_id, lesson_id, section_id, section_index, kind, outcome, source, provider, model, fallback_steps,
       fallback_reasons, from_cache, saved_shared, error_code, ms, created_at, study_date)
     VALUES (@participant_id, @lesson_id, @section_id, @section_index, @kind, @outcome, @source, @provider, @model, @fallback_steps,
       @fallback_reasons, @from_cache, @saved_shared, @error_code, @ms, @created_at, @study_date)`,
  ).run({ ...row, created_at: now.toISOString(), study_date: studyDate(now, config) });
}

// Runs the chain for one rewrite, logs it (ai_calls and the server log) and returns what the route sends, or throws
// the error the student should see. -> { version, answered_by: { source, provider, model }, shared, fallback }
export async function liveRewrite({ db, ai, envAi, section, kind, participant, shared, clock, schedulerConfig, log = console }) {
  const steps = rewriteSteps({ db, ai, envAi, section, kind, participant, shared });
  const started = Date.now();
  const result = await runChain(steps);
  const ms = Date.now() - started;
  const answered = result.ok ? result.step : null;
  const savedShared = Boolean(answered && answered.source === 'default' && answered.saved === true);
  // a step that retried itself before answering (Gemma's 5xx) is listed too, e.g. "default:rate_limit;gemma:provider_error"
  const retried = (result.step.retried ?? []).map((code) => `${result.step.source}:${code}`);
  const reasons = [...result.failures.map((f) => `${f.source}:${f.code}`), ...retried].join(';') || null;
  const last = result.step;
  logAiCall(
    db,
    {
      participant_id: participant?.id ?? null,
      lesson_id: section.lesson_id,
      section_id: section.id,
      section_index: section.index ?? null,
      kind,
      outcome: result.ok ? 'ok' : 'failed',
      source: answered?.source ?? null,
      provider: last.provider,
      model: last.model,
      // how many times the request moved on to the next step: the failed steps before the answer or, when nothing
      // answered, the steps tried after the first (a 404 on the only step tried is 0)
      fallback_steps: result.ok ? result.steps : result.failures.length - 1,
      fallback_reasons: reasons,
      from_cache: answered?.fromCache ? 1 : 0,
      saved_shared: savedShared ? 1 : 0,
      error_code: result.ok ? null : (result.error?.code ?? 'error'),
      ms,
    },
    { now: clock(), config: schedulerConfig },
  );
  const who = participant?.code ?? 'no participant';
  const tag = `[ai-live] ${who} ${kind} section ${section.id}`;
  if (result.ok) {
    const fell = result.steps ? ` after ${result.steps} fallback(s) (${reasons})` : '';
    log.log?.(`${tag}: ${answered.source}${answered.fromCache ? ' (cached)' : ''} ${answered.provider ?? ''}/${answered.model ?? ''} answered${fell} in ${(ms / 1000).toFixed(1)}s`);
  } else {
    log.warn?.(`${tag}: failed (${reasons}) in ${(ms / 1000).toFixed(1)}s`);
    throw finalError(result.error);
  }
  return {
    version: result.value,
    answered_by: { source: answered.source, provider: answered.provider, model: answered.model },
    shared: savedShared || Boolean(answered.fromCache),
    fallback: result.steps ? { steps: result.steps, note: fallbackNote({ source: answered.source, failures: result.failures }) } : null,
  };
}
