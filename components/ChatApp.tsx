"use client";

import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { AskPanel } from "./AskPanel";
import { SideMenu } from "./SideMenu";
import styles from "./ChatApp.module.css";

const DESKTOP_QUERY = "(min-width: 769px)";

type Props = {
  profileCard: ReactNode;
  candidateName: string;
  photoUrl?: string;
  starterQuestions: string[];
  breakItQuestions: string[];
  blurb: string;
};

export function ChatApp({ profileCard, breakItQuestions, candidateName }: Props) {
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const subscribeToViewport = useCallback((onChange: () => void) => {
    const media = window.matchMedia(DESKTOP_QUERY);
    function update() {
      // Move focus before the breakpoint change hides the sidebar.
      if (!media.matches && document.getElementById("side-menu")?.contains(document.activeElement)) {
        menuButtonRef.current?.focus();
      }
      onChange();
    }
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const pinned = useSyncExternalStore(subscribeToViewport, () => window.matchMedia(DESKTOP_QUERY).matches, () => false);
  const [menu, setMenu] = useState({ pinned, open: pinned });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Crossing the breakpoint restores that layout's default menu state.
  if (menu.pinned !== pinned) setMenu({ pinned, open: pinned });
  const open = menu.pinned === pinned ? menu.open : pinned;

  function closeMenu() {
    setMenu({ pinned, open: false });
    menuButtonRef.current?.focus();
  }

  // A chip fills the composer, focuses it with the caret at the end, and never submits.
  // Done directly (not in an effect) so it also works when the chip text equals the current input.
  function fill(q: string) {
    flushSync(() => setInput(q));
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // On the stacked mobile layout the composer may be off screen.
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 768px)").matches) {
      el.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
  }

  return (
    <div className={styles.app}>
      <header className={styles.topbar}>
        <button
          ref={menuButtonRef}
          type="button"
          className={styles.menuButton}
          aria-label="Menu"
          aria-expanded={open}
          aria-controls="side-menu"
          onClick={() => open ? closeMenu() : setMenu({ pinned, open: true })}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <h1 className={styles.title}>CV-AI · Ask about {candidateName}</h1>
      </header>
      <div className={`${styles.layout} ${pinned && open ? styles.withMenu : ""}`}>
        <SideMenu
          open={open}
          pinned={pinned}
          onClose={closeMenu}
          onClear={() => {}}
          clearDisabled={true}
          profileCard={profileCard}
          breakItQuestions={breakItQuestions}
          onPick={(q) => {
            if (!pinned) flushSync(closeMenu);
            fill(q);
          }}
          pickDisabled={busy}
        />
        <section className={styles.main} inert={open && !pinned}>
          <AskPanel
            candidateName={candidateName}
            input={input}
            onInputChange={setInput}
            busy={busy}
            onBusyChange={setBusy}
            inputRef={inputRef}
          />
        </section>
      </div>
    </div>
  );
}
