import { readFile } from "node:fs/promises";
import path from "node:path";
import { getCorpus } from "@/lib/corpus-cache";
import { logServerError } from "@/lib/log";
import { guardLocalRequest } from "@/lib/request-guard";

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export async function GET(request: Request) {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  try {
    const { photoPath } = await getCorpus();
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
    logServerError("Failed to serve photo", err);
    return Response.json({ error: "Could not load the photo." }, { status: 500 });
  }
}
