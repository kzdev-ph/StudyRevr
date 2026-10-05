// /v1/models lists everything a provider hosts. NVIDIA NIM in particular mixes in embedding, reranking, reward,
// safety, speech, image and OCR models that can't answer a chat request. Keep only models that plausibly can.
const NON_CHAT_NAME = new RegExp(
  [
    'embed', 'rerank', 'reward', 'retriev', 'guard', 'safety', 'moderation', 'jailbreak', 'topic-control',
    'whisper', 'parakeet', 'canary', 'fastpitch', 'speech', 'stable-diffusion', 'flux', 'sdxl', 'cosmos-(?:predict|transfer)',
    'detector', 'deplot',
    // short tokens only count as whole name parts ('nemotron-parse' yes, 'derivative' no)
    '(?:^|[/_.-])(?:riva|tts|asr|clip|nvclip|sd3|ocr|parse|bge|e5|gte|nvolve)(?:[/_.-]|$)',
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
  return !NON_CHAT_NAME.test(id);
}

// Accepts the OpenAI shape ({ data: [{ id }] }) or a bare array; returns unique, case-insensitively sorted ids.
export function chatModelIds(payload) {
  const list = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(list)) return [];
  const ids = list.filter(isChatModel).map((m) => (typeof m === 'string' ? m : m.id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}
