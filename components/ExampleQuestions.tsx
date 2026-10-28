"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./ExampleQuestions.module.css";

type DisclosureProps = {
  label: string;
  id: string;
  questions: string[];
  variant: "ask" | "break";
  disabled: boolean;
  onPick: (question: string) => void;
};

function QuestionDisclosure({ label, id, questions, variant, disabled, onPick }: DisclosureProps) {
  const [show, setShow] = useState(false);
  const chipsRef = useRef<HTMLDivElement>(null);

  // After an expand, move focus to (and scroll to) the first newly revealed chip.
  useEffect(() => {
    if (!show) return;
    const chip = chipsRef.current?.querySelector<HTMLButtonElement>("button");
    if (chip) {
      chip.focus();
      if (typeof chip.scrollIntoView === "function") chip.scrollIntoView({ block: "nearest" });
    }
  }, [show]);

  if (questions.length === 0) return null;

  const breakIt = variant === "break";
  return (
    <div>
      <button
        type="button"
        className={`${styles.toggle} ${styles.breakToggle} ${breakIt ? "" : styles.askToggle}`}
        aria-expanded={show}
        aria-controls={id}
        onClick={() => setShow((v) => !v)}
      >
        {label} ({questions.length})
      </button>
      {show && (
        <div id={id} ref={chipsRef} className={styles.chips} role="group" aria-label={label}>
          {questions.map((q) => (
            <button key={q} type="button" className={`${styles.chip} ${breakIt ? styles.breakChip : ""}`} disabled={disabled} onClick={() => onPick(q)}>{q}</button>
          ))}
        </div>
      )}
    </div>
  );
}

type Props = { questions: string[]; disabled: boolean; onPick: (question: string) => void };

export function TryAskingQuestions(props: Props) {
  return <QuestionDisclosure {...props} label="Try asking" id="try-asking-chips" variant="ask" />;
}

export function BreakItQuestions({ breakItQuestions, ...rest }: Omit<Props, "questions"> & { breakItQuestions: string[] }) {
  return <QuestionDisclosure {...rest} questions={breakItQuestions} label="Try to break it" id="break-it-chips" variant="break" />;
}
