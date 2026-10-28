import { NextResponse, type NextRequest } from "next/server";
import { checkInvite, INVITE_COOKIE } from "@/lib/invite";

/**
 * Invite gate for deployed copies. With INVITE_TOKENS unset (local dev) every request passes.
 * A visitor opens /?invite=<token> once; the token moves into an httpOnly cookie and the
 * query string is dropped. Requests without a valid cookie get a plain 404.
 */
export function proxy(request: NextRequest) {
  const result = checkInvite({
    queryToken: request.nextUrl.searchParams.get("invite"),
    cookieToken: request.cookies.get(INVITE_COOKIE)?.value ?? null,
    configured: process.env.INVITE_TOKENS,
  });
  if (result.kind === "pass") return NextResponse.next();
  if (result.kind === "deny") {
    return new NextResponse("Not found.", { status: 404, headers: { "content-type": "text/plain" } });
  }
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

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
