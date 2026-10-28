import { Suspense } from "react";
import { connection } from "next/server";
import { loadProfileView } from "@/lib/profile-view";
import { ChatApp } from "@/components/ChatApp";
import styles from "./page.module.css";

async function Profile() {
  await connection();
  const view = await loadProfileView();
  if (!view) {
    return <p className={styles.problem}>The profile could not be loaded. Check the server console for details.</p>;
  }
  const { profile, photoUrl } = view;
  return (
    <>
      <title>{`Ask about ${profile.name}`}</title>
      <ChatApp
        starterQuestions={profile.starterQuestions}
        breakItQuestions={profile.breakItQuestions}
        candidateName={profile.name}
        photoUrl={photoUrl}
        blurb={profile.blurb}
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
