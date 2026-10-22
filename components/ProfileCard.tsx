"use client";

import { useState } from "react";
import type { Profile } from "@/lib/corpus";
import Link from "next/link";
import styles from "./ProfileCard.module.css";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

function isSafeUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function ProfileCard({ profile, photoUrl }: { profile: Profile; photoUrl?: string }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const showPhoto = Boolean(photoUrl) && !photoFailed;
  return (
    <article className={styles.card}>
      <div className={styles.banner} aria-hidden="true" />
      <div className={styles.body}>
        {showPhoto ? (
          <div className={styles.avatar}>
            {/* Plain <img>: the source is a local API route, so next/image optimization adds nothing. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.photo} src={photoUrl} alt={profile.name} onError={() => setPhotoFailed(true)} />
          </div>
        ) : (
          <div className={styles.avatar} aria-hidden="true">{initials(profile.name)}</div>
        )}
        <h1 className={styles.name}>{profile.name}</h1>
        <p className={styles.headline}>{profile.headline}</p>

        <h2 className={styles.sectionTitle}>About</h2>
        <p className={styles.about}>{profile.about}</p>

        {profile.links.length > 0 && (
          <>
            <h2 className={styles.sectionTitle}>Links</h2>
            <ul className={styles.links}>
              {profile.links.map((l) => (
                <li key={l.url}>
                  {isSafeUrl(l.url) ? (
                    <a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a>
                  ) : (
                    <span>{l.label}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        <p className={styles.blurb}>
          {profile.blurb} <Link href="/how-it-works">How this works &rarr;</Link>
        </p>
      </div>
    </article>
  );
}
