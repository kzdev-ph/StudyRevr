import { z } from 'zod';
import { createAiClient } from '../src/ai/client.js';

// Shared by the AI tests. Nothing here touches the network: every "provider" is a scripted fetch.
export const KEY = 'AIza-SECRET-KEY-123';
export const CFG = { baseUrl: 'https://example.test/v1/', apiKey: KEY, model: 'acme/chat-1' };

export const completion = (content, extra = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: extra.finish ?? 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

export const failure = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// Scripted fetch: each call takes the next entry (a Response, or a function returning/throwing one); the last repeats.
export function scriptedFetch(...steps) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return typeof step === 'function' ? step() : step.clone();
  };
  fn.calls = calls;
  return fn;
}

export const makeClient = (fetchImpl, cfg = CFG, extra = {}) => {
  const sleeps = [];
  const client = createAiClient({ getConfig: () => cfg, fetchImpl, sleep: async (ms) => void sleeps.push(ms), random: () => 0, ...extra });
  client.sleeps = sleeps;
  return client;
};

export const schema = z.object({ answer: z.string().min(1), n: z.number() });
