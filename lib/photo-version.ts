import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

/** Short cache-busting token for the photo file. A hash, so it never reveals the path. Server-side only. */
export async function photoVersion(photoPath: string): Promise<string> {
  const s = await stat(photoPath);
  return createHash("sha1").update(`${photoPath}${s.mtimeMs}${s.size}`).digest("hex").slice(0, 10);
}
