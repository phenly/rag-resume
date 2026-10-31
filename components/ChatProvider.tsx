"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createEventParser } from "@/lib/events";
import { MAX_HISTORY_CHARS, MAX_HISTORY_TURNS, type Turn } from "@/lib/history";
import type { CardStatus } from "./AnswerCard";

const ANNOUNCEMENTS = {
  complete: "Answer finished.",
  incomplete: "Answer cut off at its length limit.",
  refused: "Answer declined.",
  error: "Answer failed.",
} as const;

export type Card = { id: number; question: string; text: string; status: CardStatus; error?: string; sig?: string };

export type Chat = {
  cards: Card[];
  input: string;
  setInput(value: string): void;
  busy: boolean;
  announce: string;
  submit(raw: string): void;
  clear(): void;
};

const ChatContext = createContext<Chat | null>(null);

/**
 * Holds the conversation (cards with their signatures, the composer draft, the busy flag) above the
 * pages, so it survives client navigation to /about and back. Memory only: a full reload starts over.
 * An answer still streaming when the chat page unmounts keeps streaming into this state.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");
  const nextId = useRef(1);
  // Bumped by clear(); a request from an older generation stops touching state.
  const generation = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  // submit() builds history from the latest committed cards.
  const cardsRef = useRef(cards);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  const chat = useMemo<Chat>(() => {
    async function submit(raw: string) {
      const question = raw.trim();
      if (!question || inFlight.current) return;
      // Only answers the server signed go back as history, oldest first.
      const history: Turn[] = cardsRef.current
        .filter((c) => c.sig)
        .slice(-MAX_HISTORY_TURNS)
        .map((c) => ({ question: c.question, answer: c.text, sig: c.sig as string }));
      // The server rejects oversize history, so drop the oldest turns until it fits.
      let chars = history.reduce((n, t) => n + t.question.length + t.answer.length, 0);
      while (history.length > 0 && chars > MAX_HISTORY_CHARS) {
        const dropped = history.shift() as Turn;
        chars -= dropped.question.length + dropped.answer.length;
      }
      const id = nextId.current++;
      const gen = generation.current;
      const controller = new AbortController();
      inFlight.current = controller;
      const live = () => generation.current === gen;
      const update = (patch: (c: Card) => Card) => {
        if (live()) setCards((cs) => cs.map((c) => (c.id === id ? patch(c) : c)));
      };
      setAnnounce("");
      setBusy(true);
      setInput("");
      setCards((cs) => [...cs, { id, question, text: "", status: "streaming" }]);

      let terminal = false;
      let outcome: keyof typeof ANNOUNCEMENTS = "error";
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, history }),
          signal: controller.signal,
        });
        if (res.status !== 200) {
          let message = "Something went wrong. Try again.";
          try {
            const data = await res.json();
            if (typeof data?.error === "string") message = data.error;
          } catch {}
          update((c) => ({ ...c, status: "error", error: message }));
          return;
        }
        if (!res.body) throw new Error("no body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parse = createEventParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const ev of parse(decoder.decode(value, { stream: true }))) {
            if (ev.type === "text") {
              update((c) => ({ ...c, text: c.text + ev.text }));
            } else if (ev.type === "done") {
              terminal = true;
              outcome = ev.status;
              update((c) => ({ ...c, status: ev.status, sig: ev.sig }));
            } else if (ev.type === "error") {
              terminal = true;
              update((c) => ({ ...c, status: "error", error: ev.message }));
            }
          }
        }
        if (!terminal) {
          update((c) => ({ ...c, status: "error", error: "The answer ended unexpectedly. Try again." }));
        }
      } catch {
        update((c) =>
          c.status === "streaming" ? { ...c, status: "error", error: "Could not reach the server. Try again." } : c,
        );
      } finally {
        if (inFlight.current === controller) inFlight.current = null;
        if (live()) {
          setAnnounce(ANNOUNCEMENTS[outcome]);
          setBusy(false);
        }
      }
    }

    function clear() {
      generation.current++;
      inFlight.current?.abort();
      inFlight.current = null;
      setCards([]);
      setInput("");
      setBusy(false);
      setAnnounce("");
    }

    return {
      cards: [],
      input: "",
      setInput,
      busy: false,
      announce: "",
      submit: (raw: string) => void submit(raw),
      clear,
    };
  }, []);

  const value = useMemo(() => ({ ...chat, cards, input, busy, announce }), [chat, cards, input, busy, announce]);
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/** The shared conversation, or null outside a ChatProvider. */
export function useOptionalChat() {
  return useContext(ChatContext);
}

export function useChat() {
  const chat = useContext(ChatContext);
  if (!chat) throw new Error("useChat must be used inside <ChatProvider>.");
  return chat;
}
