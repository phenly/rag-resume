import { Suspense } from "react";
import { connection } from "next/server";
import { loadCorpus, resolveCorpusDir } from "@/lib/corpus";
import { ProfileCard } from "@/components/ProfileCard";
import { AskPanel } from "@/components/AskPanel";
import styles from "./page.module.css";

async function Profile() {
  // Read the corpus per request so edits show up after a refresh.
  await connection();
  let profile;
  let photoPath;
  try {
    ({ profile, photoPath } = await loadCorpus(resolveCorpusDir()));
  } catch (err) {
    // Log details server-side only; nothing from err reaches the page.
    const e = err as { message?: string; entryTitle?: string; detail?: string };
    console.error("Failed to load corpus:", e?.message ?? String(err), e?.entryTitle ? `(entry: ${e.entryTitle})` : "", e?.detail ? `(detail: ${e.detail})` : "");
    return <p className={styles.problem}>The profile could not be loaded. Check the server console for details.</p>;
  }
  return (
    <>
      <title>{`Ask about ${profile.name}`}</title>
      <aside className={styles.sidebar}>
        {/* ProfileCard is a client component: strip the photo filename before it reaches the browser. */}
        <ProfileCard profile={{ ...profile, photo: undefined }} photoUrl={photoPath ? "/api/photo" : undefined} />
      </aside>
      <section className={styles.main}>
        <AskPanel
          starterQuestions={profile.starterQuestions}
          breakItQuestions={profile.breakItQuestions}
          candidateName={profile.name}
        />
      </section>
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
