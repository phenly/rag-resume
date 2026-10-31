"use client";

import { Fragment, useEffect, useRef, type RefObject } from "react";
import { EmptyState } from "./EmptyState";
import { StarterChips } from "./StarterChips";
import { AnswerCard } from "./AnswerCard";
import { useChat } from "./ChatProvider";
import styles from "./AskPanel.module.css";

const NEAR_BOTTOM_PX = 80;

type AskPanelProps = {
  candidateName: string;
  photoUrl?: string;
  blurb: string;
  starterQuestions: string[];
  onPick: (q: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
};

// The conversation lives in ChatProvider (mounted in the root layout) so it survives navigation.
export function AskPanel({ candidateName, photoUrl, blurb, starterQuestions, onPick, inputRef }: AskPanelProps) {
  const { cards, announce, input, setInput: onInputChange, busy, submit: send } = useChat();
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Auto-scroll as cards change, but only if the reader is already near the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [cards]);

  function onListScroll() {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  function submit(raw: string) {
    if (!raw.trim() || busy) return;
    stickToBottom.current = true;
    send(raw);
  }

  return (
    <div className={styles.panel}>
      <div
        ref={listRef}
        className={styles.answers}
        role="region"
        aria-label="Answers"
        tabIndex={0}
        onScroll={onListScroll}
      >
        {cards.length === 0 && (
          <EmptyState photoUrl={photoUrl} name={candidateName} blurb={blurb} />
        )}
        {cards.map((c) => (
          <Fragment key={c.id}>
            <div className={styles.userBubble} data-message="user">
              <p className={styles.userText}><span className="sr-only">You asked: </span>{c.question}</p>
            </div>
            <AnswerCard text={c.text} status={c.status} error={c.error} />
          </Fragment>
        ))}
      </div>
      <div className={styles.announcer} aria-live="polite">{announce}</div>

      {cards.length === 0 && <StarterChips questions={starterQuestions} disabled={busy} onPick={onPick} />}

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <label htmlFor="question" className={styles.label}>Ask about {candidateName}</label>
        <textarea
          id="question"
          ref={inputRef}
          className={styles.textarea}
          rows={2}
          maxLength={1000}
          value={input}
          placeholder={`What would you like to know about ${candidateName}?`}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(input);
            }
          }}
        />
        <button type="submit" className={styles.ask} disabled={busy || !input.trim()}>Ask</button>
      </form>
    </div>
  );
}
