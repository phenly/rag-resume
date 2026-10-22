import styles from "./ExampleQuestions.module.css";

type Props = {
  starterQuestions: string[];
  breakItQuestions: string[];
  disabled: boolean;
  onPick: (question: string) => void;
};

export function ExampleQuestions({ starterQuestions, breakItQuestions, disabled, onPick }: Props) {
  return (
    <section className={styles.card} aria-labelledby="examples-heading">
      <h2 id="examples-heading" className={styles.heading}>Try asking</h2>
      <div className={styles.chips} role="group" aria-label="Example questions">
        {starterQuestions.map((q) => (
          <button key={q} type="button" className={styles.chip} disabled={disabled} onClick={() => onPick(q)}>{q}</button>
        ))}
      </div>
      {breakItQuestions.length > 0 && (
        <>
          <h3 className={styles.subheading}>Try to break it</h3>
          <div className={styles.chips} role="group" aria-label="Try to break it">
            {breakItQuestions.map((q) => (
              <button key={q} type="button" className={`${styles.chip} ${styles.breakChip}`} disabled={disabled} onClick={() => onPick(q)}>{q}</button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
