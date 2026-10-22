import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadCorpus, resolveCorpusDir } from "@/lib/corpus";

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export async function GET() {
  try {
    const { photoPath } = await loadCorpus(resolveCorpusDir());
    if (!photoPath) return Response.json({ error: "No photo." }, { status: 404 });
    const type = TYPES[path.extname(photoPath).toLowerCase()];
    if (!type) return Response.json({ error: "No photo." }, { status: 404 });
    const data = await readFile(photoPath);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const e = err as { message?: string; entryTitle?: string; detail?: string };
    console.error("Failed to serve photo:", e?.message ?? String(err), e?.entryTitle ? `(entry: ${e.entryTitle})` : "", e?.detail ? `(detail: ${e.detail})` : "");
    return Response.json({ error: "Could not load the photo." }, { status: 500 });
  }
}
