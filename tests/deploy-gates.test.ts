import { afterEach, describe, expect, it, vi } from "vitest";
import { checkInvite } from "@/lib/invite";
import { allowedHostnames, guardLocalRequest } from "@/lib/request-guard";

describe("checkInvite", () => {
  const configured = "abc, def";

  it("passes everything when no tokens are configured", () => {
    expect(checkInvite({ queryToken: null, cookieToken: null, configured: undefined })).toEqual({ kind: "pass" });
    expect(checkInvite({ queryToken: null, cookieToken: null, configured: " , " })).toEqual({ kind: "pass" });
  });

  it("moves a valid query token into the cookie", () => {
    expect(checkInvite({ queryToken: "def", cookieToken: null, configured })).toEqual({
      kind: "set-cookie",
      token: "def",
    });
  });

  it("denies a wrong query token even with a valid cookie", () => {
    expect(checkInvite({ queryToken: "nope", cookieToken: "abc", configured })).toEqual({ kind: "deny" });
  });

  it("passes a valid cookie and denies a missing or revoked one", () => {
    expect(checkInvite({ queryToken: null, cookieToken: "abc", configured })).toEqual({ kind: "pass" });
    expect(checkInvite({ queryToken: null, cookieToken: null, configured })).toEqual({ kind: "deny" });
    expect(checkInvite({ queryToken: null, cookieToken: "old", configured })).toEqual({ kind: "deny" });
  });
});

describe("ALLOWED_HOSTS", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("adds deployed hostnames to the loopback set", () => {
    expect(allowedHostnames({ ALLOWED_HOSTS: " Example.vercel.app ,," })).toEqual(
      new Set(["127.0.0.1", "localhost", "[::1]", "example.vercel.app"]),
    );
  });

  it("lets a listed host through and still blocks others", () => {
    vi.stubEnv("ALLOWED_HOSTS", "example.vercel.app");
    const ok = new Request("https://example.vercel.app/api/photo", {
      headers: { host: "example.vercel.app", origin: "https://example.vercel.app" },
    });
    expect(guardLocalRequest(ok)).toBeNull();
    const other = new Request("https://evil.test/api/photo", { headers: { host: "evil.test" } });
    expect(guardLocalRequest(other)?.status).toBe(403);
    const crossSite = new Request("https://example.vercel.app/api/photo", {
      headers: { host: "example.vercel.app", origin: "https://evil.test" },
    });
    expect(guardLocalRequest(crossSite)?.status).toBe(403);
  });
});
