/**
 * Server-side error logging that never goes through console.*: React replays
 * Server Component console calls into the browser under `next dev`, and the
 * detail fields can contain absolute filesystem paths. stderr is not patched.
 */
export function logServerError(context: string, err: unknown): void {
  const e = err as { message?: string; entryTitle?: string; detail?: string } | null;
  const parts = [`${context}: ${e?.message ?? String(err)}`];
  if (e?.entryTitle) parts.push(`(entry: ${e.entryTitle})`);
  if (e?.detail) parts.push(`(detail: ${e.detail})`);
  process.stderr.write(parts.join(" ") + "\n");
}
