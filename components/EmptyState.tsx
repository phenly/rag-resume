"use client";

import { useState } from "react";
import Link from "next/link";
import styles from "./EmptyState.module.css";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

type Props = { photoUrl?: string; name: string; blurb: string };

export function EmptyState({ photoUrl, name, blurb }: Props) {
  const [photoFailed, setPhotoFailed] = useState(false);
  return (
    <div className={styles.empty}>
      {photoUrl && !photoFailed ? (
        // Plain <img>: the source is a local API route, so next/image optimization adds nothing.
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.photo} src={photoUrl} alt={name} onError={() => setPhotoFailed(true)} />
      ) : (
        <div className={styles.photo} aria-hidden="true">{initials(name)}</div>
      )}
      <p className={styles.text}>{blurb}</p>
      <p className={styles.text}>
        Or you can <Link href="/how-it-works" className={styles.link}>see how this app works →</Link>
      </p>
    </div>
  );
}
