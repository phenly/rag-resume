import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "@/components/ChatApp";

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
  starterQuestions: ["Starter one?", "Starter two?", "Starter three?", "Starter four?"],
  breakItQuestions: ["Break one?", "Break two?"],
  blurb: "A resume can't capture a career. Ask anything about mine.",
  candidateName: "Jordan Example",
};

function pickChip(name: string) {
  const toggle = screen.getByRole("button", { name: "Try to break it (2)" });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name }));
}

function chipAsk(name: string) {
  pickChip(name);
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(width > 768px)",
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});
afterEach(() => vi.unstubAllGlobals());

describe("ChatApp + AskPanel", () => {
  it("clicking a break-it chip fills the box without submitting", async () => {
    fetchMock.mockResolvedValue(ndjson([line({ type: "text", text: "Hi" }), line({ type: "done", status: "complete" })]));
    render(<ChatApp profileCard={<div />} {...props} />);
    pickChip("Break one?");
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("Break one?"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: "Break one? Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ask");
    expect(JSON.parse(init.body)).toEqual({ question: "Break one? Edited", history: [] });
    await screen.findByText("Hi");
  });

  it("disables input while streaming", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockResolvedValue(
      ndjson([line({ type: "text", text: "Part" }), line({ type: "done", status: "complete" })], gate),
    );
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    await screen.findByText("Part");
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Break two?" })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Break two?" })).toBeEnabled());
  });

  it("renders each exchange as a user bubble then an answer bubble, oldest first", async () => {
    fetchMock.mockImplementation(async () =>
      ndjson([line({ type: "text", text: "ans" }), line({ type: "done", status: "complete" })]),
    );
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    await waitFor(() => expect(screen.getByRole("button", { name: "Break two?" })).toBeEnabled());
    chipAsk("Break two?");
    await waitFor(() => expect(document.querySelectorAll("[data-message]")).toHaveLength(4));
    const msgs = Array.from(document.querySelectorAll("[data-message]"));
    expect(msgs.map((m) => m.getAttribute("data-message"))).toEqual(["user", "answer", "user", "answer"]);
    expect(msgs[0]).toHaveTextContent("Break one?");
    expect(msgs[2]).toHaveTextContent("Break two?");
    expect(msgs[1]).toHaveTextContent("ans");
  });

  it("shows no visible name labels, only screen-reader prefixes", async () => {
    fetchMock.mockImplementation(async () =>
      ndjson([line({ type: "text", text: "ans" }), line({ type: "done", status: "complete" })]),
    );
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    await waitFor(() => expect(document.querySelectorAll("[data-message]")).toHaveLength(2));
    const [user, answer] = Array.from(document.querySelectorAll("[data-message]"));
    expect(user.textContent).toBe("You asked: Break one?");
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
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    expect(await screen.findByText("That question is too long.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("error after chunks shows partial text plus error, spinner gone", async () => {
    fetchMock.mockResolvedValue(
      ndjson([line({ type: "text", text: "Partial answer" }), line({ type: "error", message: "Cut off." })]),
    );
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    expect(await screen.findByText("Cut off.")).toBeInTheDocument();
    expect(screen.getByText("Partial answer")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("event split across chunks renders correctly", async () => {
    const full = line({ type: "text", text: "Split text" });
    fetchMock.mockResolvedValue(
      ndjson([full.slice(0, 10), full.slice(10), line({ type: "done", status: "complete" })]),
    );
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    expect(await screen.findByText("Split text")).toBeInTheDocument();
  });

  it("stream ending without a terminal event shows an error", async () => {
    fetchMock.mockResolvedValue(ndjson([line({ type: "text", text: "Dangling" })]));
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Dangling")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Enter submits and Shift+Enter does not", async () => {
    fetchMock.mockResolvedValue(ndjson([line({ type: "done", status: "complete" })]));
    render(<ChatApp profileCard={<div />} {...props} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Typed question" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ question: "Typed question", history: [] });
  });

  it("re-enables Ask and chips after an error", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Nope." }), { status: 500 }));
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    await screen.findByText("Nope.");
    expect(screen.getByRole("button", { name: "Break two?" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "again" } });
    expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled();
  });

  it("Enter during IME composition does not submit", () => {
    render(<ChatApp profileCard={<div />} {...props} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "にほん" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("announces a status-aware message when an answer ends", async () => {
    fetchMock.mockResolvedValue(ndjson([line({ type: "done", status: "incomplete" })]));
    const { container } = render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    await waitFor(() =>
      expect(container.querySelector("[aria-live]")).toHaveTextContent("Answer cut off at its length limit."),
    );
  });

  const body = (i: number) => JSON.parse(fetchMock.mock.calls[i][1].body);
  const askAgain = async (name: string) => {
    await waitFor(() => expect(screen.getByRole("button", { name }) ).toBeEnabled());
    chipAsk(name);
  };

  it("sends signed turns as history", async () => {
    fetchMock.mockImplementation(async () =>
      ndjson([line({ type: "text", text: "ans1" }), line({ type: "done", status: "complete", sig: "s1" })]),
    );
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    await askAgain("Break two?");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(body(1)).toEqual({
      question: "Break two?",
      history: [{ question: "Break one?", answer: "ans1", sig: "s1" }],
    });
  });

  it("leaves unsigned answers out of history", async () => {
    fetchMock.mockImplementation(async () =>
      ndjson([line({ type: "text", text: "cut" }), line({ type: "done", status: "incomplete" })]),
    );
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    await askAgain("Break two?");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(body(1).history).toEqual([]);
  });

  it("leaves errored and refused answers out of history", async () => {
    fetchMock
      .mockResolvedValueOnce(ndjson([line({ type: "done", status: "refused" })]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Nope." }), { status: 500 }))
      .mockResolvedValue(ndjson([line({ type: "done", status: "complete", sig: "s" })]));
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    await askAgain("Break two?");
    await screen.findByText("Nope.");
    await askAgain("Break one?");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(body(2).history).toEqual([]);
  });

  it("sends at most the last 6 signed turns", async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => {
      n++;
      return ndjson([line({ type: "text", text: `a${n}` }), line({ type: "done", status: "complete", sig: `s${n}` })]);
    });
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    for (let i = 1; i < 8; i++) await askAgain("Break one?");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
    const history = body(7).history;
    expect(history).toHaveLength(6);
    expect(history.map((t: { sig: string }) => t.sig)).toEqual(["s2", "s3", "s4", "s5", "s6", "s7"]);
  });

  it("drops the oldest signed turns until history fits the character cap", async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => {
      n++;
      return ndjson([line({ type: "text", text: `${n}`.repeat(6000) }), line({ type: "done", status: "complete", sig: `s${n}` })]);
    });
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    for (let i = 1; i < 5; i++) await askAgain("Break one?");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    // 4 prior turns of ~6011 chars each: only the newest two (~12022) fit in 16000.
    expect(body(4).history.map((t: { sig: string }) => t.sig)).toEqual(["s3", "s4"]);
  });

  it("shows the expired-conversation message", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "This conversation expired. Clear chat to start again." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ChatApp profileCard={<div />} {...props} />);
    chipAsk("Break one?");
    expect(await screen.findByText("This conversation expired. Clear chat to start again.")).toBeInTheDocument();
  });

  describe("empty state, starters and Clear chat", () => {
    const answered = () =>
      ndjson([line({ type: "text", text: "ans" }), line({ type: "done", status: "complete", sig: "s1" })]);

    it("empty state shows the blurb and a how-this-works link before any question; both disappear after the first", async () => {
      fetchMock.mockImplementation(async () => answered());
      render(<ChatApp profileCard={<div />} {...props} />);
      expect(screen.getByText(props.blurb)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "see how this app works →" })).toHaveAttribute("href", "/how-it-works");
      expect(screen.getByText(/Or you can/)).toBeInTheDocument();
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hello?" } });
      fireEvent.click(screen.getByRole("button", { name: "Ask" }));
      await screen.findByText("ans");
      expect(screen.queryByText(props.blurb)).toBeNull();
      expect(screen.queryByRole("link", { name: "see how this app works →" })).toBeNull();
    });

    it("starter row shows three starters; clicking one fills without submitting; row hides once a question is sent", async () => {
      fetchMock.mockImplementation(async () => answered());
      render(<ChatApp profileCard={<div />} {...props} />);
      const row = screen.getByRole("group", { name: "Starter questions" });
      const chips = within(row).getAllByRole("button");
      expect(chips.map((c) => c.textContent)).toEqual(["Starter one?", "Starter two?", "Starter three?"]);
      fireEvent.click(chips[1]);
      const box = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(box).toHaveValue("Starter two?");
      expect(box).toHaveFocus();
      expect(fetchMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Ask" }));
      await screen.findByText("ans");
      expect(screen.queryByRole("group", { name: "Starter questions" })).toBeNull();
    });

    it("Clear chat empties the conversation and brings back the empty state and starters", async () => {
      fetchMock.mockImplementation(async () => answered());
      render(<ChatApp profileCard={<div />} {...props} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hello?" } });
      fireEvent.click(screen.getByRole("button", { name: "Ask" }));
      await screen.findByText("ans");
      const clear = screen.getByRole("button", { name: "Clear chat" });
      await waitFor(() => expect(clear).toBeEnabled());
      fireEvent.click(clear);
      expect(document.querySelectorAll("[data-message]")).toHaveLength(0);
      expect(screen.getByText(props.blurb)).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Starter questions" })).toBeInTheDocument();
    });

    it("Clear chat is disabled while an answer streams", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      fetchMock.mockResolvedValue(
        ndjson([line({ type: "text", text: "Part" }), line({ type: "done", status: "complete" })], gate),
      );
      render(<ChatApp profileCard={<div />} {...props} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Q" } });
      fireEvent.click(screen.getByRole("button", { name: "Ask" }));
      await screen.findByText("Part");
      expect(screen.getByRole("button", { name: "Clear chat" })).toBeDisabled();
      release();
      await waitFor(() => expect(screen.getByRole("button", { name: "Clear chat" })).toBeEnabled());
    });

    it("a cleared conversation sends no history on the next question", async () => {
      fetchMock.mockImplementation(async () => answered());
      render(<ChatApp profileCard={<div />} {...props} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "First?" } });
      fireEvent.click(screen.getByRole("button", { name: "Ask" }));
      await screen.findByText("ans");
      await waitFor(() => expect(screen.getByRole("button", { name: "Clear chat" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Clear chat" }));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Second?" } });
      fireEvent.click(screen.getByRole("button", { name: "Ask" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(body(1)).toEqual({ question: "Second?", history: [] });
    });
  });
});
