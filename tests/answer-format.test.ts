import { describe, expect, it } from "vitest";
import { splitBasedOn } from "@/lib/answer-format";

describe("splitBasedOn", () => {
  it("splits a trailing Based on line", () => {
    expect(splitBasedOn("Body\n\nBased on: Acme, Beta Corp")).toEqual({ body: "Body", basedOn: "Acme, Beta Corp" });
  });
  it("returns null basedOn when absent", () => {
    expect(splitBasedOn("Just a body")).toEqual({ body: "Just a body", basedOn: null });
  });
  it("ignores Based on mid-text", () => {
    const s = "Based on: X\n\nMore text after";
    expect(splitBasedOn(s)).toEqual({ body: s, basedOn: null });
  });
  it("tolerates trailing whitespace", () => {
    expect(splitBasedOn("Body\nBased on: A, B  \n")).toEqual({ body: "Body", basedOn: "A, B" });
  });
});
