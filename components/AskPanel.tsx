"use client";

import { useRef, useState } from "react";
import { createEventParser } from "@/lib/events";
import { AnswerCard, type CardStatus } from "./AnswerCard";
import styles from "./AskPanel.module.css";

type Card = { id: number; question: string; text: string; status: CardStatus; error?: string };

export function AskPanel({ starterQuestions, breakItQuestions, candidateName }: { starterQuestions: string[]; breakItQuestions: string[]; candidateName: string }) {
  const [input, setInput] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);

  async function submit(raw: string) {
    const question = raw.trim();
    if (!question || busy) return;
    const id = nextId.current++;
    const update = (patch: (c: Card) => Card) =>
      setCards((cs) => cs.map((c) => (c.id === id ? patch(c) : c)));
    setBusy(true);
    setInput("");
    setCards((cs) => [{ id, question, text: "", status: "streaming" }, ...cs]);

    let terminal = false;
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
      setBusy(false);
    }
  }

  return (
    <div className={styles.panel}>
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
          className={styles.textarea}
          rows={3}
          maxLength={1000}
          value={input}
          disabled={false}
          placeholder={`What would you like to know about ${candidateName}?`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit(input);
            }
          }}
        />
        <button type="submit" className={styles.ask} disabled={busy || !input.trim()}>Ask</button>
      </form>

      <div className={styles.chips} aria-label="Starter questions">
        {starterQuestions.map((q) => (
          <button key={q} type="button" className={styles.chip} disabled={busy} onClick={() => void submit(q)}>{q}</button>
        ))}
      </div>
      {breakItQuestions.length > 0 && (
        <div className={styles.chips} role="group" aria-label="Try to break it">
          <span className={styles.groupLabel}>Try to break it</span>
          {breakItQuestions.map((q) => (
            <button key={q} type="button" className={`${styles.chip} ${styles.breakChip}`} disabled={busy} onClick={() => void submit(q)}>{q}</button>
          ))}
        </div>
      )}

      <div className={styles.answers} aria-live="polite">
        {cards.map((c) => (
          <AnswerCard key={c.id} question={c.question} text={c.text} status={c.status} error={c.error} />
        ))}
      </div>
    </div>
  );
}
