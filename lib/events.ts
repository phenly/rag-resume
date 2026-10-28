/** Wire protocol for /api/ask: newline-delimited JSON, one AskEvent per line. `sig` (complete answers only) lets the client send the turn back as history. */
export type AskEvent =
  | { type: "text"; text: string }
  | { type: "done"; status: "complete" | "incomplete" | "refused"; sig?: string }
  | { type: "error"; message: string };

/** Longest question the server accepts. (Lives here: Next route files may only export handlers/config.) */
export const MAX_QUESTION_CHARS = 1000;

export function encodeEvent(e: AskEvent): string {
  return JSON.stringify(e) + "\n";
}

/** Returns a parser that buffers partial lines across chunks. */
export function createEventParser(): (chunk: string) => AskEvent[] {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    return lines.filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as AskEvent);
  };
}
