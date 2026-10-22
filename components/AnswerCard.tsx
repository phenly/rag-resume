import Markdown from "react-markdown";
import { splitBasedOn } from "@/lib/answer-format";
import styles from "./AnswerCard.module.css";

export type CardStatus = "streaming" | "complete" | "incomplete" | "refused" | "error";

export function AnswerCard({ question, text, status, error }: { question: string; text: string; status: CardStatus; error?: string }) {
  const { body, basedOn } = splitBasedOn(text);
  return (
    <section className={styles.card}>
      <h3 className={styles.question}>{question}</h3>
      {body && (
        <div className={styles.body}>
          <Markdown disallowedElements={["img"]} components={{ a: "span" }}>
            {body}
          </Markdown>
        </div>
      )}
      {status === "streaming" && <span className={styles.spinner} role="status" aria-label="Loading" />}
      {status === "complete" && basedOn && <p className={styles.muted}>Based on: {basedOn}</p>}
      {status === "incomplete" && <p className={styles.muted}>The answer hit its length limit.</p>}
      {status === "refused" && <p className={styles.muted}>This question was declined.</p>}
      {status === "error" && (
        <p className={styles.error} role="alert">{error ?? "Something went wrong. Try again."}</p>
      )}
    </section>
  );
}
