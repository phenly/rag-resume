// Splits the model's answer into body and the final "Based on:" line.
// Only a final non-empty line counts; "Based on:" elsewhere is ordinary text.
// Emphasis variants (**Based on:**, *Based on:*, _Based on:_) are accepted.
// An empty "Based on:" line is removed from the body and yields basedOn null.
export function splitBasedOn(answer: string): { body: string; basedOn: string | null } {
  const trimmed = answer.trim();
  const idx = trimmed.lastIndexOf("\n");
  const lastLine = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  const m = /^\s*(?:\*\*|\*|__|_)?Based on:(?:\*\*|\*|__|_)?\s*(.*?)\s*$/.exec(lastLine);
  if (!m || idx === -1) return { body: trimmed, basedOn: null };
  const value = m[1].replace(/^(?:\*\*|\*|__|_)+|(?:\*\*|\*|__|_)+$/g, "").trim();
  return { body: trimmed.slice(0, idx).trim(), basedOn: value || null };
}
