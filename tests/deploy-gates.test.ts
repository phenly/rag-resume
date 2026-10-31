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

describe("proxy invite gate", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function denied(path: string, init: { method?: string; accept?: string } = {}) {
    vi.stubEnv("INVITE_TOKENS", "abc");
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const headers: Record<string, string> = {};
    if (init.accept) headers.accept = init.accept;
    return proxy(new NextRequest(`https://example.vercel.app${path}`, { method: init.method ?? "GET", headers }));
  }

  it("gives a browser page request a friendly HTML 404 with no personal content", async () => {
    const res = await denied("/about", { accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const html = await res.text();
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("This page needs an invite link");
    expect(html).toContain("Open the full link you were sent — it ends with ?invite= followed by a code.");
    expect(html).toContain("If it isn't working, ask the person who shared it for a fresh one.");
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//i);
  });

  it("serves the HTML page for HEAD too", async () => {
    const res = await denied("/", { method: "HEAD", accept: "text/html" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  });

  it("keeps the plain-text 404 for API, non-HTML and non-GET requests", async () => {
    for (const res of [
      await denied("/api/ask", { accept: "text/html" }),
      await denied("/api/photo"),
      await denied("/", { accept: "application/json" }),
      await denied("/", { method: "POST", accept: "text/html" }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/plain");
      expect(await res.text()).toBe("Not found.");
    }
  });
});
