import type { Metadata } from "next";
import Link from "next/link";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "How CV-AI works" };

const boxes = [
  { title: "1. Your question", note: "Typed in the browser" },
  { title: "2. The server", note: "Adds the career archive and the answer rules" },
  { title: "3. Claude", note: "Reads the archive and writes an answer" },
  { title: "4. Streamed answer", note: "Appears word by word, with its sources" },
];

const next = [
  { title: "Search over embeddings", text: "Instead of giving Claude the whole archive every time, find and send only the most relevant passages." },
  { title: "Guardrails", text: "Stronger, tested checks that keep private or off-topic material out of answers." },
  { title: "A question log", text: "Record which questions people ask so the archive can fill the gaps." },
  { title: "Evaluation", text: "A repeatable set of questions that scores answer quality whenever something changes." },
];

export default function HowItWorks() {
  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back}>&larr; Back to the chat</Link>
      <article className={styles.card}>
        <h1>How CV-AI works</h1>
        <p>
          This page is an experiment: instead of reading a resume, you ask questions and get answers drawn from a
          private archive of career notes written by the candidate. The version you are looking at is an early alpha.
        </p>

        <h2>From question to answer</h2>
        <svg
          className={styles.diagram}
          viewBox="0 0 760 130"
          role="img"
          aria-label="Flow diagram: your question goes to the server, which sends it with the career archive and answer rules to Claude, and the answer streams back."
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className={styles.arrowHead} />
            </marker>
          </defs>
          {boxes.map((b, i) => {
            const x = i * 195;
            return (
              <g key={b.title}>
                <rect x={x} y={15} width={165} height={100} rx={10} className={styles.box} />
                <text x={x + 82.5} y={50} textAnchor="middle" className={styles.boxTitle}>{b.title}</text>
                <foreignObject x={x + 8} y={58} width={149} height={54}>
                  <p className={styles.boxNote}>{b.note}</p>
                </foreignObject>
                {i < boxes.length - 1 && (
                  <line x1={x + 167} y1={65} x2={x + 192} y2={65} className={styles.arrow} markerEnd="url(#arrow)" />
                )}
              </g>
            );
          })}
        </svg>

        <ol className={styles.steps}>
          <li>Your question is sent to the server running on this computer.</li>
          <li>The server attaches the whole career archive, kept in a reusable cache so repeat questions are fast and cheap, plus the rules the answer must follow.</li>
          <li>Claude reads the archive and writes an answer, staying inside what the archive says.</li>
          <li>The answer streams back to you as it is written, followed by a short note on which material it used.</li>
        </ol>

        <h2>What to keep in mind</h2>
        <p>
          Answers come only from the archive. If something is not covered, or is private, the assistant says so and
          points you to the candidate instead of guessing. Try the &ldquo;Try to break it&rdquo; questions to see that
          for yourself.
        </p>

        <h2>What&rsquo;s next</h2>
        <ul className={styles.next}>
          {next.map((n) => (
            <li key={n.title}><strong>{n.title}.</strong> {n.text}</li>
          ))}
        </ul>
      </article>
    </main>
  );
}
