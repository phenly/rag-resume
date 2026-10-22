import { Suspense } from "react";
import { connection } from "next/server";
import { getCorpus } from "@/lib/corpus-cache";
import { logServerError } from "@/lib/log";
import { photoVersion } from "@/lib/photo-version";
import { ProfileCard } from "@/components/ProfileCard";
import { AskShell } from "@/components/AskShell";
import styles from "./page.module.css";

async function Profile() {
  // Corpus is cached after the first successful load; restart to pick up edits.
  await connection();
  let profile;
  let photoPath;
  let photoUrl: string | undefined;
  try {
    ({ profile, photoPath } = await getCorpus());
  } catch (err) {
    // Log details server-side only; nothing from err reaches the page.
    // stderr, not console: React replays server console calls (with paths) into the browser in dev.
    logServerError("Failed to load corpus", err);
    return <p className={styles.problem}>The profile could not be loaded. Check the server console for details.</p>;
  }
  if (photoPath) {
    try {
      // Version token busts the browser cache when the photo file changes (the route ignores it).
      photoUrl = `/api/photo?v=${await photoVersion(photoPath)}`;
    } catch (err) {
      // A photo-only failure must not take down the page; fall back to initials.
      logServerError("Failed to version photo", err);
    }
  }
  return (
    <>
      <title>{`Ask about ${profile.name}`}</title>
      {/* ProfileCard is a client component: pass only display fields to the browser. */}
      <AskShell
        profileCard={<ProfileCard profile={{ name: profile.name, headline: profile.headline, about: profile.about, links: profile.links, blurb: profile.blurb, starterQuestions: [], breakItQuestions: [] }} photoUrl={photoUrl} />}
        starterQuestions={profile.starterQuestions}
        breakItQuestions={profile.breakItQuestions}
        candidateName={profile.name}
      />
    </>
  );
}

export default function Home() {
  return (
    <main className={styles.page}>
      <Suspense fallback={<p className={styles.problem}>Loading&hellip;</p>}>
        <Profile />
      </Suspense>
    </main>
  );
}
