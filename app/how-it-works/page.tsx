import type { Metadata } from "next";
import Link from "next/link";
import { howItWorksCopy, howItWorksMode } from "@/lib/how-it-works-copy";
import { configuredApproach, configuredStrategy } from "@/lib/retrieval/load";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "How CV-AI works" };

export default function HowItWorks() {
  const { boxes, diagramLabel, steps, privacy, next } = howItWorksCopy(howItWorksMode(configuredApproach(), configuredStrategy()));
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
          aria-label={diagramLabel}
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
          {steps.map((step) => <li key={step}>{step}</li>)}
        </ol>

        <h2>Your questions and privacy</h2>
        {privacy.map((p) => <p key={p}>{p}</p>)}

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
