"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { BreakItQuestions, TryAskingQuestions } from "./ExampleQuestions";
import styles from "./SideMenu.module.css";

type Props = {
  open: boolean;
  pinned: boolean;
  onClose(): void;
  onClear(): void;
  clearDisabled: boolean;
  candidateName: string;
  starterQuestions: string[];
  breakItQuestions: string[];
  onPick(q: string): void;
  pickDisabled: boolean;
  /** Viewport not known yet (server render / hydration): CSS decides whether the menu shows. */
  auto?: boolean;
};

export function SideMenu({ open, pinned, onClose, onClear, clearDisabled, candidateName, starterQuestions, breakItQuestions, onPick, pickDisabled, auto }: Props) {
  const firstName = candidateName.trim().split(/\s+/)[0];
  const menuRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open && !pinned) closeRef.current?.focus();
  }, [open, pinned]);

  return (
    <>
      {open && !pinned && (
        <button type="button" className={styles.backdrop} tabIndex={-1} aria-label="Close menu backdrop" onClick={onClose} />
      )}
      <aside
        id="side-menu"
        ref={menuRef}
        className={styles.menu}
        hidden={!open}
        data-auto={auto ? "true" : undefined}
        tabIndex={pinned ? undefined : -1}
        role={pinned ? "complementary" : "dialog"}
        aria-label="Menu"
        aria-modal={!pinned && open ? true : undefined}
        onKeyDown={(e) => {
          if (pinned) return;
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Tab") {
            const controls = menuRef.current?.querySelectorAll<HTMLElement>(":is(button:not(:disabled), a[href])");
            if (!controls?.length) return;
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        {!pinned && (
          <button ref={closeRef} type="button" className={styles.close} aria-label="Close menu" onClick={onClose}>×</button>
        )}
        <Link href="/about" className={styles.link} onClick={() => { if (!pinned) onClose(); }}>About {firstName}</Link>
        <Link href="/how-it-works" className={styles.link} onClick={() => { if (!pinned) onClose(); }}>How CV-AI Works</Link>
        <TryAskingQuestions questions={starterQuestions} disabled={pickDisabled} onPick={onPick} />
        <BreakItQuestions breakItQuestions={breakItQuestions} disabled={pickDisabled} onPick={onPick} />
        <button
          type="button"
          className={styles.action}
          disabled={clearDisabled}
          onClick={() => {
            onClear();
            if (!pinned) onClose();
          }}
        >Clear chat</button>
      </aside>
    </>
  );
}
