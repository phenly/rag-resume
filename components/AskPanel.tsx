"use client";

import { Fragment, useEffect, useRef, useState, type RefObject } from "react";
import { createEventParser } from "@/lib/events";
import { MAX_HISTORY_CHARS, MAX_HISTORY_TURNS, type Turn } from "@/lib/history";
import { EmptyState } from "./EmptyState";
import { StarterChips } from "./StarterChips";
import { AnswerCard, type CardStatus } from "./AnswerCard";
import styles from "./AskPanel.module.css";

const NEAR_BOTTOM_PX = 80;

const ANNOUNCEMENTS = {
  complete: "Answer finished.",
  incomplete: "Answer cut off at its length limit.",
  refused: "Answer declined.",
  error: "Answer failed.",
} as const;

type Card = { id: number; question: string; text: string; status: CardStatus; error?: string; sig?: string };

type AskPanelProps = {
  candidateName: string;
  photoUrl?: string;
  blurb: string;
  starterQuestions: string[];
  onPick: (q: string) => void;
  input: string;
  onInputChange: (value: string) => void;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
};

export function AskPanel({ candidateName, photoUrl, blurb, starterQuestions, onPick, input, onInputChange, busy, onBusyChange, inputRef }: AskPanelProps) {
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
    // Only answers the server signed go back as history, oldest first.
    const history: Turn[] = cards
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
        body: JSON.stringify({ question, history }),
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
          <EmptyState photoUrl={photoUrl} name={candidateName} blurb={blurb} />
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

      {cards.length === 0 && <StarterChips questions={starterQuestions} disabled={busy} onPick={onPick} />}

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
