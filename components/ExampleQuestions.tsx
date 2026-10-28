"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./ExampleQuestions.module.css";

type Props = {
  breakItQuestions: string[];
  disabled: boolean;
  onPick: (question: string) => void;
};

export function BreakItQuestions({ breakItQuestions, disabled, onPick }: Props) {
  const [showBreak, setShowBreak] = useState(false);
  const chipsRef = useRef<HTMLDivElement>(null);

  // After an expand, move focus to (and scroll to) the first newly revealed chip.
  useEffect(() => {
    if (!showBreak) return;
    const chip = chipsRef.current?.querySelector<HTMLButtonElement>("button");
    if (chip) {
      chip.focus();
      if (typeof chip.scrollIntoView === "function") chip.scrollIntoView({ block: "nearest" });
    }
  }, [showBreak]);

  if (breakItQuestions.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        className={`${styles.toggle} ${styles.breakToggle}`}
        aria-expanded={showBreak}
        aria-controls="break-it-chips"
        onClick={() => setShowBreak((v) => !v)}
      >
        Try to break it ({breakItQuestions.length})
      </button>
      {showBreak && (
        <div id="break-it-chips" ref={chipsRef} className={styles.chips} role="group" aria-label="Try to break it">
          {breakItQuestions.map((q) => (
            <button key={q} type="button" className={`${styles.chip} ${styles.breakChip}`} disabled={disabled} onClick={() => onPick(q)}>{q}</button>
          ))}
        </div>
      )}
    </div>
  );
}
