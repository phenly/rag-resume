"use client";

import { Fragment, useEffect, useRef, useState, type RefObject } from "react";
import { createEventParser } from "@/lib/events";
import { AnswerCard, type CardStatus } from "./AnswerCard";
import styles from "./AskPanel.module.css";

const NEAR_BOTTOM_PX = 80;

const ANNOUNCEMENTS = {
  complete: "Answer finished.",
  incomplete: "Answer cut off at its length limit.",
  refused: "Answer declined.",
  error: "Answer failed.",
} as const;

type Card = { id: number; question: string; text: string; status: CardStatus; error?: string };

type AskPanelProps = {
  candidateName: string;
  input: string;
  onInputChange: (value: string) => void;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
};

export function AskPanel({ candidateName, input, onInputChange, busy, onBusyChange, inputRef }: AskPanelProps) {
  const [cards, setCards] = useState<Card[]>([]);
  const [announce, setAnnounce] = useState("");
  const nextId = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Auto-scroll as cards change, but only if the reader is already near the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [cards]);

  function onListScroll() {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  async function submit(raw: string) {
    const question = raw.trim();
    if (!question || busy) return;
    const id = nextId.current++;
    const update = (patch: (c: Card) => Card) =>
      setCards((cs) => cs.map((c) => (c.id === id ? patch(c) : c)));
    stickToBottom.current = true;
    setAnnounce("");
    onBusyChange(true);
    onInputChange("");
    setCards((cs) => [...cs, { id, question, text: "", status: "streaming" }]);

    let terminal = false;
    let outcome: "complete" | "incomplete" | "refused" | "error" = "error";
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
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
            update((c) => ({ ...c, status: ev.status }));
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
      setAnnounce(ANNOUNCEMENTS[outcome]);
      onBusyChange(false);
    }
  }

  return (
    <div className={styles.panel}>
      <div
        ref={listRef}
        className={styles.answers}
        role="region"
        aria-label="Answers"
        tabIndex={0}
        onScroll={onListScroll}
      >
        {cards.length === 0 && (
          <p className={styles.empty}>Ask anything about {candidateName} &mdash; or pick an example question to start.</p>
        )}
        {cards.map((c) => (
          <Fragment key={c.id}>
            <div className={styles.userBubble} data-message="user">
              <p className={styles.userText}><span className="sr-only">You asked: </span>{c.question}</p>
            </div>
            <AnswerCard text={c.text} status={c.status} error={c.error} />
          </Fragment>
        ))}
      </div>
      <div className={styles.announcer} aria-live="polite">{announce}</div>

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit(input);
        }}
      >
        <label htmlFor="question" className={styles.label}>Ask about {candidateName}</label>
        <textarea
          id="question"
          ref={inputRef}
          className={styles.textarea}
          rows={2}
          maxLength={1000}
          value={input}
          placeholder={`What would you like to know about ${candidateName}?`}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit(input);
            }
          }}
        />
        <button type="submit" className={styles.ask} disabled={busy || !input.trim()}>Ask</button>
      </form>
    </div>
  );
}
