import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "@/components/ChatApp";
import { ChatProvider } from "@/components/ChatProvider";
import RootLayout from "@/app/layout";

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
  starterQuestions: ["Starter one?"],
  breakItQuestions: ["Break one?"],
  blurb: "Ask anything.",
  candidateName: "Jordan Example",
};

// Stands in for client navigation: the chat page unmounts while another page shows, then comes back.
function Pages({ page }: { page: "chat" | "about" }) {
  return <ChatProvider>{page === "chat" ? <ChatApp {...props} /> : <p>About page</p>}</ChatProvider>;
}

function ask(question: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: question } });
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

describe("ChatProvider", () => {
  it("keeps the conversation and its signed history when the chat page unmounts and comes back", async () => {
    fetchMock.mockResolvedValueOnce(ndjson([line({ type: "text", text: "First answer" }), line({ type: "done", status: "complete", sig: "s1" })]));
    const { rerender } = render(<Pages page="chat" />);
    ask("First?");
    await screen.findByText("First answer");
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear chat" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Draft" } });

    rerender(<Pages page="about" />);
    expect(screen.queryByText("First answer")).toBeNull();
    rerender(<Pages page="chat" />);

    expect(screen.getByText("First?")).toBeInTheDocument();
    expect(screen.getByText("First answer")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Draft");

    fetchMock.mockResolvedValueOnce(ndjson([line({ type: "text", text: "Second" }), line({ type: "done", status: "complete" })]));
    ask("Second?");
    await screen.findByText("Second");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).history).toEqual([{ question: "First?", answer: "First answer", sig: "s1" }]);
  });

  it("an answer streaming during navigation keeps streaming into the provider and frees the composer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockResolvedValueOnce(
      ndjson([line({ type: "text", text: "Part" }), line({ type: "text", text: " two" }), line({ type: "done", status: "complete", sig: "s1" })], gate),
    );
    const { rerender } = render(<Pages page="chat" />);
    ask("Q?");
    await screen.findByText("Part");
    rerender(<Pages page="about" />);
    release();
    await new Promise((r) => setTimeout(r, 20));
    rerender(<Pages page="chat" />);
    await screen.findByText("Part two");
    expect(screen.getAllByText("Q?")).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Next" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Clear chat" })).toBeEnabled();
  });

  it("Clear chat empties the shared conversation, so coming back shows the empty state", async () => {
    fetchMock.mockResolvedValueOnce(ndjson([line({ type: "text", text: "Answer" }), line({ type: "done", status: "complete", sig: "s1" })]));
    const { rerender } = render(<Pages page="chat" />);
    ask("Q?");
    await screen.findByText("Answer");
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear chat" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Clear chat" }));
    expect(screen.queryByText("Answer")).toBeNull();
    rerender(<Pages page="about" />);
    rerender(<Pages page="chat" />);
    expect(screen.queryByText("Answer")).toBeNull();
    expect(screen.getByText("Ask anything.")).toBeInTheDocument();
  });

  it("the root layout mounts the provider around every page", () => {
    const page = <p>child</p>;
    const tree = RootLayout({ children: page } as never) as ReactElement;
    function find(node: ReactNode): ReactElement | null {
      if (!isValidElement(node)) return null;
      if (node.type === ChatProvider) return node;
      const kids = (node.props as { children?: ReactNode }).children;
      for (const k of Array.isArray(kids) ? kids : [kids]) {
        const hit = find(k);
        if (hit) return hit;
      }
      return null;
    }
    const provider = find(tree);
    expect(provider).not.toBeNull();
    expect((provider!.props as { children: ReactNode }).children).toBe(page);
  });
});
