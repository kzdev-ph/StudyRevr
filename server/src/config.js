import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const resolveDbPath = (p) => (p === ':memory:' || path.isAbsolute(p) ? p : path.join(ROOT_DIR, p));

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3001,
    dbPath: resolveDbPath(env.DB_PATH || 'server/data/studyrevr.db'),
    maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 20) * 1024 * 1024,
    ai: {
      baseUrl: env.AI_BASE_URL || '',
      apiKey: env.AI_API_KEY || '',
      model: env.AI_MODEL || '',
      timeoutMs: (Number(env.AI_TIMEOUT_SECONDS) || 300) * 1000,
      chunkTokens: Number(env.AI_CHUNK_TOKENS) || undefined, // lesson tokens per AI call; default suits 8k-context models
    },
  };
}
