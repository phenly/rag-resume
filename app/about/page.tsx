import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { loadProfileView } from "@/lib/profile-view";
import { ProfileCard } from "@/components/ProfileCard";
import styles from "./page.module.css";

async function About() {
  await connection();
  const view = await loadProfileView();
  if (!view) {
    return <p className={styles.problem}>The profile could not be loaded. Check the server console for details.</p>;
  }
  const { profile, photoUrl } = view;
  return (
    <>
      <title>{`About ${profile.name}`}</title>
      {/* ProfileCard is a client component: pass only display fields to the browser. */}
      <ProfileCard profile={{ name: profile.name, headline: profile.headline, about: profile.about, links: profile.links, blurb: "", starterQuestions: [], breakItQuestions: [] }} photoUrl={photoUrl} />
    </>
  );
}

export default function AboutPage() {
  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back}>&larr; Back to the chat</Link>
      <Suspense fallback={<p className={styles.problem}>Loading&hellip;</p>}>
        <About />
      </Suspense>
    </main>
  );
}
