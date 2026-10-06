import { Router } from 'express';
import { AiError } from '../ai/client.js';
import { PRESETS, STUDENT_PROVIDERS } from '../ai/providers.js';
import { HttpError } from '../middleware/errors.js';
import { requireParticipant } from '../middleware/participant.js';
import { resolveAiConfig } from '../services/settings.js';
import {
  deleteStudentKey,
  describeStudentKey,
  keyProblemMessage,
  readStudentKey,
  saveStudentKey,
  studentConfig,
  studentKeyBody,
  studentKeysAllowed,
  studentModelsBody,
} from '../services/student-ai.js';

const parse = (schema, body, hint) => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new HttpError(400, hint);
  return parsed.data;
};

// A student's AI choice for Explain simpler and Filipino/Taglish (gear → Settings): the admin Default, or their own
// key, which is tested before it is saved. Per participant (X-Participant). Only while admin allows it
// (allow_student_keys); removing a saved key always works. The key is never sent back: only its last 4 characters.
export function myAiRouter({ ai, db, config = {}, clock = () => new Date() }) {
  const router = Router();
  const envAi = config.ai ?? {};

  const state = (participant) => {
    const defaultCfg = resolveAiConfig(db, envAi);
    return {
      allowed: studentKeysAllowed(db),
      default: { provider: defaultCfg.provider, provider_label: defaultCfg.label, model: defaultCfg.model },
      providers: STUDENT_PROVIDERS.map((id) => ({ id, label: PRESETS[id].label, default_model: PRESETS[id].model })),
      key: describeStudentKey(readStudentKey(db, participant.id)),
    };
  };

  const requireAllowed = () => {
    if (!studentKeysAllowed(db)) throw new HttpError(403, 'Using your own AI key is turned off. Ask your teacher.', { code: 'student_keys_off' });
  };

  // A student's problem with a key or provider: a plain message, never the provider's own wording or the key.
  const keyProblem = (err, provider) => {
    if (!(err instanceof AiError)) throw err;
    const { code, message } = keyProblemMessage(err, PRESETS[provider].label);
    return new HttpError(400, message, { code });
  };

  router.get('/my-ai', (req, res) => {
    res.json(state(requireParticipant(db, req)));
  });

  // The provider's chat models for this key ({ provider, apiKey }); without apiKey, the saved key when it is for that
  // provider. -> { models }
  router.post('/my-ai/models', async (req, res, next) => {
    try {
      const participant = requireParticipant(db, req);
      requireAllowed();
      const body = parse(studentModelsBody, req.body, 'Send provider and apiKey.');
      const saved = readStudentKey(db, participant.id);
      const apiKey = body.apiKey || (saved?.provider === body.provider ? saved.api_key : '');
      if (!apiKey) throw new HttpError(400, 'Paste your key first.', { code: 'key_missing' });
      try {
        res.json({ models: await ai.listModels(studentConfig({ provider: body.provider, model: '', apiKey }), { live: true }) });
      } catch (err) {
        throw keyProblem(err, body.provider);
      }
    } catch (e) {
      next(e);
    }
  });

  // "Test key": a tiny chat request with the chosen model. The key is saved only when it passes.
  router.post('/my-ai/key', async (req, res, next) => {
    try {
      const participant = requireParticipant(db, req);
      requireAllowed();
      const body = parse(studentKeyBody, req.body, 'Send provider, model and apiKey.');
      try {
        await ai.testConnection(studentConfig(body), { live: true });
      } catch (err) {
        throw keyProblem(err, body.provider);
      }
      saveStudentKey(db, participant.id, body, clock());
      res.json({ ...state(participant), message: `Connected. ${body.model} is ready.` });
    } catch (e) {
      next(e);
    }
  });

  // "Remove my key": back to the Default.
  router.delete('/my-ai/key', (req, res) => {
    const participant = requireParticipant(db, req);
    deleteStudentKey(db, participant.id);
    res.json(state(participant));
  });

  return router;
}
