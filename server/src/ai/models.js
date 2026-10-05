import { bareModelId } from './providers.js';

// /v1/models lists everything a provider hosts. NVIDIA NIM in particular mixes in embedding, reranking, reward,
// safety, speech, image and OCR models that can't answer a chat request; Gemini adds embedding, Imagen, Veo, TTS and
// realtime (live / audio) models. Keep only models that plausibly can chat.
const NON_CHAT_NAME = new RegExp(
  [
    'embed', 'rerank', 'reward', 'retriev', 'guard', 'safety', 'moderation', 'jailbreak', 'topic-control',
    'whisper', 'parakeet', 'canary', 'fastpitch', 'speech', 'stable-diffusion', 'flux', 'sdxl', 'cosmos-(?:predict|transfer)',
    'detector', 'deplot', 'robotics',
    // short tokens only count as whole name parts ('nemotron-parse' yes, 'derivative' no); the last five are
    // Gemini's image / video generation and realtime (live) / audio models
    '(?:^|[/_.-])(?:riva|tts|asr|clip|nvclip|sd3|ocr|parse|bge|e5|gte|nvolve|imagen|veo|live|audio|image)(?:[/_.-]|$)',
  ].join('|'),
  'i',
);
const NON_CHAT_TYPES = new Set(['embedding', 'embeddings', 'rerank', 'reranker', 'image', 'audio', 'speech', 'moderation']);

export function isChatModel(model) {
  const id = typeof model === 'string' ? model : model?.id;
  if (!id || typeof id !== 'string') return false;
  const type = String(model?.type ?? model?.task ?? '').toLowerCase();
  if (type && NON_CHAT_TYPES.has(type)) return false;
  const outputs = model?.architecture?.output_modalities; // OpenRouter
  if (Array.isArray(outputs) && !outputs.includes('text')) return false;
  const methods = model?.supportedGenerationMethods; // Gemini, when it lists them
  if (Array.isArray(methods) && !methods.some((m) => /generateContent|chat/i.test(m))) return false;
  return !NON_CHAT_NAME.test(id);
}

// Accepts the OpenAI shape ({ data: [{ id }] }) or a bare array; returns unique, case-insensitively sorted ids
// without Gemini's "models/" prefix.
export function chatModelIds(payload) {
  const list = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(list)) return [];
  const ids = list.filter(isChatModel).map((m) => bareModelId(typeof m === 'string' ? m : m.id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}
