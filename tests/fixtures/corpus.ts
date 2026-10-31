import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { onTestFinished } from "vitest";

/** Synthetic source and staging workspace, kept inside the repository and cleaned after each test. */
export async function corpusFixture() {
  const scratch = path.join(process.cwd(), ".next");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "test-corpus-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "vault", "corpus");
  const sourceDir = path.join(root, "vault", "career");
  const put = async (base: string, file: string, value: string | Buffer) => {
    const full = path.join(base, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, value);
  };
  const profile = {
    name: "Pat Example", headline: "Fictional product leader", about: "A made-up career.",
    links: [], blurb: "Ask about Pat's experience.", starterQuestions: [], breakItQuestions: [],
    photo: "assets/portrait.png",
  };
  const manifest = {
    profile: "config/profile.json", answerStyle: "config/style.md",
    positioningNotes: "config/notes.md", documentsFrom: "../career/bot-export.json",
    documents: [{ title: "Overview", path: "core/overview.md" }],
  };
  const exported = {
    rules: "guidance/rules.md",
    documents: [
      { title: "Company One", path: "companies/one.md" },
      { title: "Company Two", path: "companies/two.md" },
      { title: "Company Three", path: "companies/three.md" },
    ],
  };
  const globalRules = "Use only the recorded facts about Pat Example.";
  const photoBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await put(dir, "corpus.json", JSON.stringify(manifest));
  await put(dir, manifest.profile, JSON.stringify(profile));
  await put(dir, manifest.answerStyle, "Keep answers concise.");
  await put(dir, manifest.positioningNotes, "Lead with documented outcomes.");
  await put(dir, manifest.documents[0].path, "Pat Example's fictional career overview.");
  await put(dir, profile.photo, photoBytes);
  await put(sourceDir, "bot-export.json", JSON.stringify(exported));
  await put(sourceDir, exported.rules, globalRules);
  for (const doc of exported.documents) {
    await put(sourceDir, doc.path, `Pat Example worked on a fictional project at ${doc.title}.`);
  }
  return { root, dir, sourceDir, profile, manifest, exported, globalRules, photoBytes, put };
}
