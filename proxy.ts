import { NextResponse, type NextRequest } from "next/server";
import { checkInvite, INVITE_COOKIE } from "@/lib/invite";

/**
 * Invite gate for deployed copies. With INVITE_TOKENS unset (local dev) every request passes.
 * A visitor opens /?invite=<token> once; the token moves into an httpOnly cookie and the
 * query string is dropped. Requests without a valid cookie get a 404: browser page loads see a short
 * HTML page explaining the invite link; API and other requests get plain text. Neither reads the corpus.
 */
export function proxy(request: NextRequest) {
  const result = checkInvite({
    queryToken: request.nextUrl.searchParams.get("invite"),
    cookieToken: request.cookies.get(INVITE_COOKIE)?.value ?? null,
    configured: process.env.INVITE_TOKENS,
  });
  if (result.kind === "pass") return NextResponse.next();
  if (result.kind === "deny") return deny(request);
  const clean = request.nextUrl.clone();
  clean.searchParams.delete("invite");
  const response = NextResponse.redirect(clean);
  response.cookies.set(INVITE_COOKIE, result.token, {
    httpOnly: true,
    secure: clean.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 60,
  });
  return response;
}

const INVITE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Invite link needed</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f2ef; color: #191919; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 28rem; margin: 24px; padding: 24px 28px; background: #fff; border-radius: 10px; box-shadow: 0 0 0 1px #e0dfdc; }
h1 { margin: 0 0 8px; font-size: 20px; }
p { margin: 0; color: #444; }
</style>
</head>
<body>
<main>
<h1>This page needs an invite link</h1>
<p>Open the full link you were sent — it ends with ?invite= followed by a code. If it isn't working, ask the person who shared it for a fresh one.</p>
</main>
</body>
</html>
`;

function wantsPage(request: NextRequest) {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") return false;
  const path = request.nextUrl.pathname;
  if (path === "/api" || path.startsWith("/api/")) return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function deny(request: NextRequest) {
  if (!wantsPage(request)) {
    // The body depends on Accept, so caches must key on it.
    return new NextResponse("Not found.", { status: 404, headers: { "content-type": "text/plain", vary: "accept" } });
  }
  return new NextResponse(request.method === "HEAD" ? null : INVITE_PAGE, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      vary: "accept",
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
