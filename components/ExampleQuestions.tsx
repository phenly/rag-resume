"use client";

import { useState } from "react";
import styles from "./ExampleQuestions.module.css";

const VISIBLE_STARTERS = 3;

type Props = {
  starterQuestions: string[];
  breakItQuestions: string[];
  disabled: boolean;
  onPick: (question: string) => void;
};

export function ExampleQuestions({ starterQuestions, breakItQuestions, disabled, onPick }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [showBreak, setShowBreak] = useState(false);
  const hidden = Math.max(0, starterQuestions.length - VISIBLE_STARTERS);
  const starters = showAll ? starterQuestions : starterQuestions.slice(0, VISIBLE_STARTERS);

  return (
    <section className={styles.card} aria-labelledby="examples-heading">
      <h2 id="examples-heading" className={styles.heading}>Try asking</h2>
      <div className={styles.scroll}>
        <div className={styles.chips} role="group" aria-label="Example questions">
          {starters.map((q) => (
            <button key={q} type="button" className={styles.chip} disabled={disabled} onClick={() => onPick(q)}>{q}</button>
          ))}
        </div>
        {showBreak && breakItQuestions.length > 0 && (
          <div id="break-it-chips" className={styles.chips} role="group" aria-label="Try to break it">
            {breakItQuestions.map((q) => (
              <button key={q} type="button" className={`${styles.chip} ${styles.breakChip}`} disabled={disabled} onClick={() => onPick(q)}>{q}</button>
            ))}
          </div>
        )}
      </div>
      <div className={styles.footer}>
        {hidden > 0 && (
          <button type="button" className={styles.toggle} aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Fewer examples" : `More examples (${hidden})`}
          </button>
        )}
        {breakItQuestions.length > 0 && (
          <button
            type="button"
            className={`${styles.toggle} ${styles.breakToggle}`}
            aria-expanded={showBreak}
            aria-controls="break-it-chips"
            onClick={() => setShowBreak((v) => !v)}
          >
            Try to break it ({breakItQuestions.length})
          </button>
        )}
      </div>
    </section>
  );
}
