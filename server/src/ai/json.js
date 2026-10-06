// Models wrap JSON in prose, code fences, or <think> blocks (Gemma on Google writes <thought>). Pull out the JSON
// value without being clever about it.
const THINK_BLOCK = /<(think|thinking|thought)>[\s\S]*?<\/\1>/gi;

export function stripCodeFences(text) {
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  return fenced ? fenced[1] : text;
}

// Returns the parsed value, or throws a SyntaxError describing why the reply isn't JSON.
export function parseJsonReply(raw) {
  const text = stripCodeFences(String(raw ?? '').replace(THINK_BLOCK, '')).trim();
  if (!text) throw new SyntaxError('the reply was empty');
  try {
    return JSON.parse(text);
  } catch (firstError) {
    // Leading/trailing commentary: try the span from the first brace/bracket to the last matching one.
    const open = text.search(/[{[]/);
    const close = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (open !== -1 && close > open) {
      try {
        return JSON.parse(text.slice(open, close + 1));
      } catch {
        // fall through to the original error
      }
    }
    throw new SyntaxError(firstError.message);
  }
}
