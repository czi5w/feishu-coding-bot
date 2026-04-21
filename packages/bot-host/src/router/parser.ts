/**
 * Strip all Lark `<at ...>...</at>` blocks and collapse surrounding whitespace.
 * Returns `null` if the residual instruction text is shorter than 2 chars
 * (per SPEC §7.3 — a bare @ with no command is treated as a ping, not a task).
 */
export function normalizeInstruction(rawText: string): string | null {
  // Match both self-closing `<at .../>` and paired `<at ...></at>` forms.
  // Non-greedy, flags i for case insensitivity.
  const stripped = rawText
    .replace(/<at\b[^>]*\/\s*>/gi, " ")
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped.length < 2) return null;
  return stripped;
}
