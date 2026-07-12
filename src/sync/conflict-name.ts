/** `dir/note.md` → `dir/note (conflicted copy).md` — the label for a keep-both when two replicas diverge
 *  (a first-import CRDT divergence, or a last-writer-wins binary conflict). Preserves the extension. */
export function conflictName(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash
    ? `${path.slice(0, dot)} (conflicted copy)${path.slice(dot)}`
    : `${path} (conflicted copy)`;
}
