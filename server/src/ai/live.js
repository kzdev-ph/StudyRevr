// The fallback chain for live AI calls (a student tapped Explain simpler or Filipino/Taglish and is waiting).
// Each step is tried once (no retry waits: the next step is the retry). A step hands over to the next one only for
// the failures listed in its `fallbackOn`; anything else (a bad request, a reply that isn't usable JSON) stops the
// chain, because the next model would get the same request.

// The provider is having a moment: rate limit (429), timeout, connection problem, or a 5xx.
export const OUTAGE = new Set(['rate_limit', 'timeout', 'network', 'provider_error']);
// The student's own key is the problem: rejected (401/403) or out of credit (402). Only the student step falls back on these.
export const KEY_PROBLEM = new Set(['auth', 'no_credit']);
export const STUDENT_FALLBACK = new Set([...OUTAGE, ...KEY_PROBLEM]);

// steps: [{ source, provider, model, fallbackOn: Set<code>, run: () => Promise<value> }]
// -> { ok: true, value, step, steps: failures before it, failures }
//  | { ok: false, error, step, failures }   (failures: [{ source, provider, model, code }] in order)
export async function runChain(steps) {
  const failures = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      const value = await step.run();
      return { ok: true, value, step, steps: failures.length, failures };
    } catch (error) {
      const code = error?.code ?? 'error';
      failures.push({ source: step.source, provider: step.provider, model: step.model, code });
      if (i === steps.length - 1 || !step.fallbackOn.has(code)) return { ok: false, error, step, failures };
    }
  }
  throw new RangeError('runChain needs at least one step');
}

// The line shown under an answer that came from a fallback; null when the first choice answered.
export function fallbackNote({ source, failures }) {
  if (!failures.length) return null;
  const studentFailed = failures.some((f) => f.source === 'student');
  if (source === 'default') return studentFailed ? 'Your key didn’t work, so the default AI answered.' : null;
  if (source === 'gemma') {
    return studentFailed ? 'Your key didn’t work and the main AI was busy, so a backup AI answered.' : 'The main AI was busy, so a backup AI answered.';
  }
  return null;
}
