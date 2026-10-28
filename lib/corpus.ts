import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ANSWER_STYLE } from "./answer-style";
import { redactContacts } from "./redact";

export type Profile = {
  name: string;
  headline: string;
  about: string;
  links: { label: string; url: string }[];
  blurb: string; // "what is this" text under the links
  photo?: string; // path relative to the corpus dir
  starterQuestions: string[];
  breakItQuestions: string[];
};
export type CorpusDocument = { title: string; text: string }; // text already redacted
export type Corpus = {
  profile: Profile;
  answerStyle: string;
  positioningNotes: string;
  documents: CorpusDocument[];
  photoPath?: string; // absolute real path, validated; undefined when profile has no photo
};

export class CorpusError extends Error {
  entryTitle?: string;
  /** Server-side detail (may contain filesystem paths); never show to clients. */
  detail?: string;
  constructor(message: string, opts: { entryTitle?: string; detail?: string } = {}) {
    super(message);
    this.name = "CorpusError";
    this.entryTitle = opts.entryTitle;
    this.detail = opts.detail;
  }
}

/** CORPUS_DIR (relative values resolve against the repo root / cwd) or <repo>/sample-corpus. */
export function resolveCorpusDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.CORPUS_DIR?.trim();
  return path.resolve(process.cwd(), configured || "sample-corpus");
}

async function readText(dir: string, p: string, label: string, entryTitle?: string): Promise<string> {
  const full = path.resolve(dir, p);
  try {
    return await readFile(full, "utf8");
  } catch {
    throw new CorpusError(`Corpus ${label} is missing or unreadable`, {
      entryTitle,
      detail: full,
    });
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CorpusError(`Corpus ${label} is not valid JSON`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => isStr(v) && v.trim() !== "";
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

type Manifest = {
  profile: string;
  answerStyle?: string;
  positioningNotes: string;
  documents: { title: string; path: string }[];
};

function validateManifest(m: unknown): Manifest {
  if (!isObj(m)) throw new CorpusError("corpus.json must be an object");
  if (!isNonEmpty(m.profile)) throw new CorpusError("corpus.json: profile must be a file path string");
  if (!isNonEmpty(m.positioningNotes))
    throw new CorpusError("corpus.json: positioningNotes must be a file path string");
  if (m.answerStyle !== undefined && !isNonEmpty(m.answerStyle))
    throw new CorpusError("corpus.json: answerStyle must be a file path string");
  if (!Array.isArray(m.documents)) throw new CorpusError("corpus.json: documents must be an array");
  m.documents.forEach((d, i) => {
    if (!isObj(d) || !isNonEmpty(d.title) || !isNonEmpty(d.path))
      throw new CorpusError(`corpus.json: documents[${i}] needs a non-empty title and path`);
  });
  return m as Manifest;
}

function validateProfile(p: unknown): Profile {
  if (!isObj(p)) throw new CorpusError("profile.json must be an object");
  for (const k of ["name", "headline", "about", "blurb"] as const) {
    if (!isStr(p[k])) throw new CorpusError(`profile.json: ${k} must be a string`);
  }
  for (const k of ["starterQuestions", "breakItQuestions"] as const) {
    if (!isStrArr(p[k])) throw new CorpusError(`profile.json: ${k} must be an array of strings`);
  }
  if (
    !Array.isArray(p.links) ||
    !p.links.every((l) => isObj(l) && isStr(l.label) && isStr(l.url))
  )
    throw new CorpusError("profile.json: links must be an array of {label, url}");
  if (p.photo !== undefined && !isNonEmpty(p.photo))
    throw new CorpusError("profile.json: photo must be a non-empty string");
  // Return only the known fields so stray keys in profile.json never reach the client.
  return {
    name: p.name as string,
    headline: p.headline as string,
    about: p.about as string,
    links: (p.links as { label: string; url: string }[]).map((l) => ({ label: l.label, url: l.url })),
    blurb: p.blurb as string,
    starterQuestions: p.starterQuestions as string[],
    breakItQuestions: p.breakItQuestions as string[],
    ...(p.photo !== undefined ? { photo: p.photo as string } : {}),
  };
}

const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** Resolve the photo to a real path that must live inside the corpus dir. */
async function resolvePhoto(dir: string, photo: string): Promise<string> {
  const full = path.resolve(dir, photo);
  if (!PHOTO_EXTS.has(path.extname(full).toLowerCase()))
    throw new CorpusError("Corpus profile photo must be a .jpg, .jpeg, .png or .webp file", { detail: full });
  let realDir: string;
  let real: string;
  try {
    realDir = await realpath(dir);
    real = await realpath(full);
  } catch {
    throw new CorpusError("Corpus profile photo is missing or unreadable", { detail: full });
  }
  const rel = path.relative(realDir, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
    throw new CorpusError("Corpus profile photo must be inside the corpus folder", { detail: real });
  if (!PHOTO_EXTS.has(path.extname(real).toLowerCase()))
    throw new CorpusError("Corpus profile photo must be a .jpg, .jpeg, .png or .webp file", { detail: real });
  let isFile: boolean;
  try {
    isFile = (await stat(real)).isFile();
  } catch {
    throw new CorpusError("Corpus profile photo is missing or unreadable", { detail: real });
  }
  if (!isFile) throw new CorpusError("Corpus profile photo must be a regular file", { detail: real });
  return real;
}

export async function loadCorpus(dir: string): Promise<Corpus> {
  const manifest = validateManifest(
    parseJson(await readText(dir, "corpus.json", "manifest"), "manifest"),
  );
  const profile = validateProfile(
    parseJson(await readText(dir, manifest.profile, "profile"), "profile"),
  );
  const answerStyle = manifest.answerStyle !== undefined
    ? await readText(dir, manifest.answerStyle, "answer style")
    : DEFAULT_ANSWER_STYLE;
  const positioningNotes = redactContacts(
    await readText(dir, manifest.positioningNotes, "positioning notes"),
  );

  const documents: CorpusDocument[] = [];
  for (const entry of manifest.documents) {
    const raw = await readText(dir, entry.path, `document "${entry.title}"`, entry.title);
    documents.push({ title: entry.title, text: redactContacts(raw) });
  }
  const photoPath = profile.photo ? await resolvePhoto(dir, profile.photo) : undefined;
  return { profile, answerStyle, positioningNotes, documents, photoPath };
}
