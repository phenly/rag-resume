import { getCorpus } from "@/lib/corpus-cache";
import { logServerError } from "@/lib/log";
import { guardLocalRequest } from "@/lib/request-guard";

export async function GET(request: Request): Promise<Response> {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  const headers = { "cache-control": "no-store" };
  try {
    const { version } = await getCorpus();
    return Response.json({ version }, { headers });
  } catch (err) {
    logServerError("[version] corpus error", err);
    return Response.json({ error: "corpus" }, { status: 500, headers });
  }
}
