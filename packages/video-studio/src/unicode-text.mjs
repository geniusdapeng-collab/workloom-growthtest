/** Video text limits count Unicode code points, including supplementary-plane Han. */
export const VIDEO_INTENT_MAX_CHARACTERS = 12_000;
export const FINAL_PROMPT_MAX_CHARACTERS = 3_000;

export function unicodeLength(value) {
  return Array.from(value).length;
}

/** The same index semantics as String#slice, without splitting surrogate pairs. */
export function unicodeSlice(value, start, end) {
  return Array.from(value).slice(start, end).join("");
}
