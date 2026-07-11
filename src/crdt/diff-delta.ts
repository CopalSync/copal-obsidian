export interface TextDelta {
  index: number;
  delete: number;
  insert: string;
}

/**
 * Minimal single-splice diff: strip the common prefix + suffix; whatever's left in the middle is the one
 * contiguous change. Good for typical single-region edits (typing, paste, delete). Scattered multi-region
 * edits produce a larger-than-necessary (but correct) splice — a diff-match-patch upgrade is noted for later.
 * Returns null when the texts are identical.
 */
export function diffToDelta(oldText: string, newText: string): TextDelta | null {
  if (oldText === newText) return null;
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    index: prefix,
    delete: oldText.length - prefix - suffix,
    insert: newText.slice(prefix, newText.length - suffix),
  };
}
