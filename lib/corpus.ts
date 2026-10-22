import { readFile } from "node:fs/promises";
import path from "node:path";
import { redactContacts } from "./redact";

export type Profile = {
  name: string;
  headline: string;
  about: string;
  links: { label: string; url: string }[];
  blurb: string; // "what is this" text under the links
  starterQuestions: string[];
  breakItQuestions: string[];
};
export type CorpusDocument = { title: string; text: string }; // text already redacted
export type Corpus = {
  profile: Profile;
  positioningNotes: string;
  documents: CorpusDocument[];
};

export class CorpusError extends Error {
  entryTitle?: string;
  constructor(message: string, entryTitle?: string) {
    super(message);
    this.name = "CorpusError";
    this.entryTitle = entryTitle;
  }
}

/** CORPUS_DIR (relative values resolve against the repo root / cwd) or <repo>/sample-corpus. */
export function resolveCorpusDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.CORPUS_DIR?.trim();
  return path.resolve(process.cwd(), configured || "sample-corpus");
}

async function readText(dir: string, p: string, title?: string): Promise<string> {
  const full = path.resolve(dir, p);
  try {
    return await readFile(full, "utf8");
  } catch {
    throw new CorpusError(
      `Cannot read ${title ? `document "${title}"` : "file"} at ${full}`,
      title,
    );
  }
}

export async function loadCorpus(dir: string): Promise<Corpus> {
  const manifestText = await readText(dir, "corpus.json");
  let manifest: {
    profile: string;
    positioningNotes: string;
    documents: { title: string; path: string }[];
  };
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new CorpusError(`corpus.json in ${dir} is not valid JSON`);
  }
  if (!manifest.profile || !manifest.positioningNotes || !Array.isArray(manifest.documents)) {
    throw new CorpusError("corpus.json must have profile, positioningNotes and documents");
  }

  let profile: Profile;
  try {
    profile = JSON.parse(await readText(dir, manifest.profile));
  } catch (e) {
    if (e instanceof CorpusError) throw e;
    throw new CorpusError(`${manifest.profile} is not valid JSON`);
  }
  const positioningNotes = await readText(dir, manifest.positioningNotes);

  const documents: CorpusDocument[] = [];
  for (const entry of manifest.documents) {
    const raw = await readText(dir, entry.path, entry.title);
    documents.push({ title: entry.title, text: redactContacts(raw) });
  }
  return { profile, positioningNotes, documents };
}
