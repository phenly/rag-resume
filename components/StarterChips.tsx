"use client";

import styles from "./StarterChips.module.css";

const MAX_STARTERS = 1;

type Props = { questions: string[]; disabled: boolean; onPick: (q: string) => void };

export function StarterChips({ questions, disabled, onPick }: Props) {
  const shown = questions.slice(0, MAX_STARTERS);
  if (shown.length === 0) return null;
  return (
    <div className={styles.chips} role="group" aria-label="Starter questions">
      {shown.map((q) => (
        <button key={q} type="button" className={styles.chip} disabled={disabled} onClick={() => onPick(q)}>{q}</button>
      ))}
    </div>
  );
}
