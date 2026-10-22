"use client";

import { useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { AskPanel } from "./AskPanel";
import { ExampleQuestions } from "./ExampleQuestions";
import styles from "./AskShell.module.css";

type Props = {
  profileCard: ReactNode;
  starterQuestions: string[];
  breakItQuestions: string[];
  candidateName: string;
};

export function AskShell({ profileCard, starterQuestions, breakItQuestions, candidateName }: Props) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A chip fills the composer, focuses it with the caret at the end, and never submits.
  // Done directly (not in an effect) so it also works when the chip text equals the current input.
  function fill(q: string) {
    flushSync(() => setInput(q));
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // On the stacked mobile layout the composer may be off screen.
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 768px)").matches) {
      el.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
  }

  return (
    <>
      <aside className={styles.sidebar}>
        {profileCard}
        <ExampleQuestions
          starterQuestions={starterQuestions}
          breakItQuestions={breakItQuestions}
          disabled={busy}
          onPick={fill}
        />
      </aside>
      <section className={styles.main}>
        <AskPanel
          candidateName={candidateName}
          input={input}
          onInputChange={setInput}
          busy={busy}
          onBusyChange={setBusy}
          inputRef={inputRef}
        />
      </section>
    </>
  );
}
