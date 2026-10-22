import { describe, expect, it } from "vitest";
import { createEventParser, encodeEvent, type AskEvent } from "@/lib/events";

describe("events", () => {
  it("round-trips each event type", () => {
    const events: AskEvent[] = [
      { type: "text", text: "hi\nthere" },
      { type: "done", status: "complete" },
      { type: "done", status: "incomplete" },
      { type: "done", status: "refused" },
      { type: "error", message: "nope" },
    ];
    for (const e of events) {
      const line = encodeEvent(e);
      expect(line.endsWith("\n")).toBe(true);
      expect(createEventParser()(line)).toEqual([e]);
    }
  });

  it("parses an event split across two chunks", () => {
    const parse = createEventParser();
    const line = encodeEvent({ type: "text", text: "split me" });
    expect(parse(line.slice(0, 7))).toEqual([]);
    expect(parse(line.slice(7))).toEqual([{ type: "text", text: "split me" }]);
  });

  it("parses several events in one chunk", () => {
    const a: AskEvent = { type: "text", text: "a" };
    const b: AskEvent = { type: "done", status: "complete" };
    expect(createEventParser()(encodeEvent(a) + encodeEvent(b))).toEqual([a, b]);
  });
});
