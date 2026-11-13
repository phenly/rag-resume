import type { Metadata } from "next";
import Link from "next/link";
import { howItWorksCopy, howItWorksMode, type HowItWorksBox } from "@/lib/how-it-works-copy";
import { configuredApproach, configuredStrategy } from "@/lib/retrieval/load";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "How CV-AI works" };

const BOX_W = 165;
const BOX_H = 100;
const STEP = 195;
const WIDTH = 3 * STEP + BOX_W;

function Row({ boxes, y, numbered }: { boxes: HowItWorksBox[]; y: number; numbered: boolean }) {
  return (
    <>
      {boxes.map((b, i) => {
        const x = i * STEP;
        return (
          <g key={b.title}>
            <rect x={x} y={y} width={BOX_W} height={BOX_H} rx={10} className={styles.box} />
            <text x={x + BOX_W / 2} y={y + 30} textAnchor="middle" className={styles.boxTitle}>
              {numbered ? `${i + 1}. ${b.title}` : b.title}
            </text>
            <foreignObject x={x + 8} y={y + 38} width={BOX_W - 16} height={BOX_H - 42}>
              <p className={styles.boxNote}>{b.note}</p>
            </foreignObject>
            {i < boxes.length - 1 && (
              <line x1={x + BOX_W + 2} y1={y + BOX_H / 2} x2={x + STEP - 3} y2={y + BOX_H / 2} className={styles.arrow} markerEnd="url(#arrow)" />
            )}
          </g>
        );
      })}
    </>
  );
}

/** One row for the per-question flow; with indexBoxes, a first row for the index build whose last box feeds the flow's second box. */
function Diagram({ boxes, indexBoxes, label }: { boxes: HowItWorksBox[]; indexBoxes?: HowItWorksBox[]; label: string }) {
  const flowY = indexBoxes ? 190 : 15;
  const linkFromX = 3 * STEP + BOX_W / 2;
  const linkToX = STEP + BOX_W / 2;
  return (
    <svg className={styles.diagram} viewBox={`0 0 ${WIDTH} ${flowY + BOX_H + 15}`} role="img" aria-label={label}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className={styles.arrowHead} />
        </marker>
      </defs>
      {indexBoxes && (
        <>
          <text x={0} y={14} className={styles.rowLabel}>Before any question</text>
          <Row boxes={indexBoxes} y={24} numbered={false} />
          <path d={`M ${linkFromX} ${24 + BOX_H + 2} V 150 H ${linkToX} V ${flowY - 3}`} className={styles.link} markerEnd="url(#arrow)" />
          <text x={0} y={flowY - 10} className={styles.rowLabel}>On every question</text>
        </>
      )}
      <Row boxes={boxes} y={flowY} numbered={!indexBoxes} />
    </svg>
  );
}

export default function HowItWorks() {
  const { boxes, indexBoxes, diagramLabel, sections, privacy, next } = howItWorksCopy(howItWorksMode(configuredApproach(), configuredStrategy()));
  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back}>&larr; Back to the chat</Link>
      <article className={styles.card}>
        <h1>How CV-AI works</h1>
        <p>
          This page is an experiment: instead of reading a resume, you ask questions and get answers drawn from a
          private archive of career notes written by the candidate. The version you are looking at is an early alpha.
        </p>

        {sections.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            {section.paragraphs?.map((p) => <p key={p}>{p}</p>)}
            {section.diagram && <Diagram boxes={boxes} indexBoxes={indexBoxes} label={diagramLabel} />}
            {section.steps && (
              <ol className={styles.steps}>
                {section.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
            )}
            {section.bullets && (
              <ul className={styles.steps}>
                {section.bullets.map((b) => <li key={b}>{b}</li>)}
              </ul>
            )}
          </section>
        ))}

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
