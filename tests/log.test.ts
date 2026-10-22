import { afterEach, describe, expect, it, vi } from "vitest";
import { logServerError } from "@/lib/log";

afterEach(() => vi.restoreAllMocks());

describe("logServerError", () => {
  it("writes message, entry and detail to stderr and never to console", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const con = [vi.spyOn(console, "error"), vi.spyOn(console, "log"), vi.spyOn(console, "warn")];
    logServerError("ctx", Object.assign(new Error("bad"), { entryTitle: "Doc", detail: "/abs/path" }));
    const out = String(write.mock.calls[0][0]);
    expect(out).toContain("ctx: bad");
    expect(out).toContain("(entry: Doc)");
    expect(out).toContain("(detail: /abs/path)");
    con.forEach((c) => expect(c).not.toHaveBeenCalled());
  });
});
