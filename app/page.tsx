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
  try {
    ({ profile } = await loadCorpus(resolveCorpusDir()));
  } catch {
    // Never leak paths or stack traces to the browser.
    return <p className={styles.problem}>The profile could not be loaded. Check the server console for details.</p>;
  }
  return (
    <>
      <title>{`Ask about ${profile.name}`}</title>
      <aside className={styles.sidebar}>
        <ProfileCard profile={profile} />
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
