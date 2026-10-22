import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskPanel } from "@/components/AskPanel";

const enc = new TextEncoder();
const line = (o: object) => JSON.stringify(o) + "\n";

function streamOf(chunks: string[], gate?: Promise<void>) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (gate && i === 1) await gate;
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else c.close();
    },
  });
}
const ndjson = (chunks: string[], gate?: Promise<void>) =>
  new Response(streamOf(chunks, gate), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });

const props = {
  starterQuestions: ["Starter one?", "Starter two?"],
  breakItQuestions: ["Break it?"],
  candidateName: "Jordan Example",
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("AskPanel", () => {
  it("clicking a starter submits it", async () => {
    fetchMock.mockResolvedValue(ndjson([line({ type: "text", text: "Hi" }), line({ type: "done", status: "complete" })]));
    render(<AskPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Starter one?" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ask");
    expect(JSON.parse(init.body)).toEqual({ question: "Starter one?" });
    await screen.findByText("Hi");
  });

  it("disables input while streaming", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockResolvedValue(
      ndjson([line({ type: "text", text: "Part" }), line({ type: "done", status: "complete" })], gate),
    );
    render(<AskPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Starter one?" }));
    await screen.findByText("Part");
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Starter two?" })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Starter two?" })).toBeEnabled());
  });

  it("stacks answers newest first", async () => {
    fetchMock.mockImplementation(async () =>
      ndjson([line({ type: "text", text: "ans" }), line({ type: "done", status: "complete" })]),
    );
    render(<AskPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Starter one?" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Starter two?" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Starter two?" }));
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2));
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Starter two?", "Starter one?"]);
  });

  it("non-200 shows the server's error on the card", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "That question is too long." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<AskPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Starter one?" }));
    expect(await screen.findByText("That question is too long.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("error after chunks shows partial text plus error, spinner gone", async () => {
    fetchMock.mockResolvedValue(
      ndjson([line({ type: "text", text: "Partial answer" }), line({ type: "error", message: "Cut off." })]),
    );
    render(<AskPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Break it?" }));
    expect(await screen.findByText("Cut off.")).toBeInTheDocument();
    expect(screen.getByText("Partial answer")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("event split across chunks renders correctly", async () => {
    const full = line({ type: "text", text: "Split text" });
    fetchMock.mockResolvedValue(
      ndjson([full.slice(0, 10), full.slice(10), line({ type: "done", status: "complete" })]),
    );
    render(<AskPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Starter one?" }));
    expect(await screen.findByText("Split text")).toBeInTheDocument();
  });

  it("stream ending without a terminal event shows an error", async () => {
    fetchMock.mockResolvedValue(ndjson([line({ type: "text", text: "Dangling" })]));
    render(<AskPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Starter one?" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Dangling")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Enter submits and Shift+Enter does not", async () => {
    fetchMock.mockResolvedValue(ndjson([line({ type: "done", status: "complete" })]));
    render(<AskPanel {...props} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Typed question" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ question: "Typed question" });
  });
});
