// Splits the model's answer into body and the final "Based on:" line.
// Only a final non-empty line counts; "Based on:" elsewhere is ordinary text.
export function splitBasedOn(answer: string): { body: string; basedOn: string | null } {
  const trimmed = answer.replace(/\s+$/, "");
  const idx = trimmed.lastIndexOf("\n");
  const lastLine = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  const m = /^\s*Based on:\s*(.+?)\s*$/.exec(lastLine);
  if (!m || idx === -1) return { body: answer, basedOn: null };
  return { body: trimmed.slice(0, idx).replace(/\s+$/, ""), basedOn: m[1] };
}
