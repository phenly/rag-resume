const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

const forbidden = () => Response.json({ error: "Forbidden." }, { status: 403 });

/**
 * Local-only app: reject requests whose Host is not loopback (DNS rebinding) and
 * browser requests whose Origin is not this same host (cross-site POSTs).
 * Returns a Response to send, or null when the request may proceed.
 */
export function guardLocalRequest(request: Request, opts: { requireJson?: boolean } = {}): Response | null {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return forbidden();
  }
  if (!LOCAL_HOSTNAMES.has(hostname)) return forbidden();

  const origin = request.headers.get("origin");
  if (origin !== null) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return forbidden();
    }
    if (originHost !== host) return forbidden();
  }

  if (opts.requireJson) {
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      return Response.json({ error: "Send JSON." }, { status: 415 });
    }
  }
  return null;
}
