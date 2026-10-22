import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskShell } from "@/components/AskShell";

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

function chipAsk(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("AskShell + AskPanel", () => {
  it("clicking a starter fills the box without submitting", async () => {
    fetchMock.mockResolvedValue(ndjson([line({ type: "text", text: "Hi" }), line({ type: "done", status: "complete" })]));
    render(<AskShell profileCard={<div />} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Starter one?" }));
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("Starter one?"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: "Starter one? Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ask");
    expect(JSON.parse(init.body)).toEqual({ question: "Starter one? Edited" });
    await screen.findByText("Hi");
  });

  it("disables input while streaming", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockResolvedValue(
      ndjson([line({ type: "text", text: "Part" }), line({ type: "done", status: "complete" })], gate),
    );
    render(<AskShell profileCard={<div />} {...props} />);
    chipAsk("Starter one?");
    await screen.findByText("Part");
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Starter two?" })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Starter two?" })).toBeEnabled());
  });

  it("renders each exchange as a user bubble then an answer bubble, oldest first", async () => {
    fetchMock.mockImplementation(async () =>
      ndjson([line({ type: "text", text: "ans" }), line({ type: "done", status: "complete" })]),
    );
    render(<AskShell profileCard={<div />} {...props} />);
    chipAsk("Starter one?");
    await waitFor(() => expect(screen.getByRole("button", { name: "Starter two?" })).toBeEnabled());
    chipAsk("Starter two?");
    await waitFor(() => expect(document.querySelectorAll("[data-message]")).toHaveLength(4));
    const msgs = Array.from(document.querySelectorAll("[data-message]"));
    expect(msgs.map((m) => m.getAttribute("data-message"))).toEqual(["user", "answer", "user", "answer"]);
    expect(msgs[0]).toHaveTextContent("Starter one?");
    expect(msgs[2]).toHaveTextContent("Starter two?");
    expect(msgs[1]).toHaveTextContent("ans");
  });

  it("shows no visible name labels, only screen-reader prefixes", async () => {
    fetchMock.mockImplementation(async () =>
      ndjson([line({ type: "text", text: "ans" }), line({ type: "done", status: "complete" })]),
    );
    render(<AskShell profileCard={<div />} {...props} />);
    chipAsk("Starter one?");
    await waitFor(() => expect(document.querySelectorAll("[data-message]")).toHaveLength(2));
    const [user, answer] = Array.from(document.querySelectorAll("[data-message]"));
    expect(user.textContent).toBe("You asked: Starter one?");
    expect(answer.textContent).toContain("Answer:");
    const hidden = Array.from(document.querySelectorAll("[data-message] .sr-only")).map((e) => e.textContent?.trim());
    expect(hidden).toEqual(["You asked:", "Answer:"]);
    expect(screen.queryByText("You")).toBeNull();
    expect(screen.queryByText("Jordan")).toBeNull();
  });

  it("non-200 shows the server's error on the card", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "That question is too long." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<AskShell profileCard={<div />} {...props} />);
    chipAsk("Starter one?");
    expect(await screen.findByText("That question is too long.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("error after chunks shows partial text plus error, spinner gone", async () => {
    fetchMock.mockResolvedValue(
      ndjson([line({ type: "text", text: "Partial answer" }), line({ type: "error", message: "Cut off." })]),
    );
    render(<AskShell profileCard={<div />} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Try to break it (1)" }));
    chipAsk("Break it?");
    expect(await screen.findByText("Cut off.")).toBeInTheDocument();
    expect(screen.getByText("Partial answer")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("event split across chunks renders correctly", async () => {
    const full = line({ type: "text", text: "Split text" });
    fetchMock.mockResolvedValue(
      ndjson([full.slice(0, 10), full.slice(10), line({ type: "done", status: "complete" })]),
    );
    render(<AskShell profileCard={<div />} {...props} />);
    chipAsk("Starter one?");
    expect(await screen.findByText("Split text")).toBeInTheDocument();
  });

  it("stream ending without a terminal event shows an error", async () => {
    fetchMock.mockResolvedValue(ndjson([line({ type: "text", text: "Dangling" })]));
    render(<AskShell profileCard={<div />} {...props} />);
    chipAsk("Starter one?");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Dangling")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Enter submits and Shift+Enter does not", async () => {
    fetchMock.mockResolvedValue(ndjson([line({ type: "done", status: "complete" })]));
    render(<AskShell profileCard={<div />} {...props} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Typed question" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ question: "Typed question" });
  });

  it("re-enables Ask and chips after an error", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Nope." }), { status: 500 }));
    render(<AskShell profileCard={<div />} {...props} />);
    chipAsk("Starter one?");
    await screen.findByText("Nope.");
    expect(screen.getByRole("button", { name: "Starter two?" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "again" } });
    expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled();
  });

  it("Enter during IME composition does not submit", () => {
    render(<AskShell profileCard={<div />} {...props} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "にほん" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clicking the same chip twice keeps focus in the box and typing does not move the caret", () => {
    render(<AskShell profileCard={<div />} {...props} />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: "Starter one?" }));
    fireEvent.click(screen.getByRole("button", { name: "Starter one?" }));
    expect(box).toHaveFocus();
    box.setSelectionRange(3, 3);
    fireEvent.change(box, { target: { value: "Starxter one?" } });
    box.setSelectionRange(5, 5);
    expect(box.selectionStart).toBe(5);
  });

  it("announces a status-aware message when an answer ends", async () => {
    fetchMock.mockResolvedValue(ndjson([line({ type: "done", status: "incomplete" })]));
    const { container } = render(<AskShell profileCard={<div />} {...props} />);
    chipAsk("Starter one?");
    await waitFor(() =>
      expect(container.querySelector("[aria-live]")).toHaveTextContent("Answer cut off at its length limit."),
    );
  });

  it("bounds starters to 3 with an expander and hides break-it chips until opened", () => {
    const five = ["A?", "B?", "C?", "D?", "E?"];
    render(<AskShell profileCard={<div />} {...props} starterQuestions={five} />);
    expect(screen.getAllByRole("button", { name: /^[A-E]\?$/ })).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Break it?" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More examples (2)" }));
    expect(screen.getAllByRole("button", { name: /^[A-E]\?$/ })).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Fewer examples" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try to break it (1)" }));
    expect(screen.getByRole("button", { name: "Break it?" })).toBeInTheDocument();
  });

  it("collapses both disclosures on a second click", () => {
    const five = ["A?", "B?", "C?", "D?", "E?"];
    render(<AskShell profileCard={<div />} {...props} starterQuestions={five} />);
    fireEvent.click(screen.getByRole("button", { name: "More examples (2)" }));
    fireEvent.click(screen.getByRole("button", { name: "Fewer examples" }));
    expect(screen.getAllByRole("button", { name: /^[A-E]\?$/ })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "More examples (2)" })).toHaveAttribute("aria-expanded", "false");
    const toggle = screen.getByRole("button", { name: "Try to break it (1)" });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Break it?" })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "Break it?" })).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("renders no toggles for short lists", () => {
    render(<AskShell profileCard={<div />} {...props} breakItQuestions={[]} />);
    expect(screen.queryByRole("button", { name: /more examples|fewer examples|break it/i })).toBeNull();
  });
});
