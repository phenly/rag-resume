import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadCorpus } from "../lib/corpus";
import { corpusSnapshot } from "../lib/corpus-version";

const fileLabels = {
  positioningNotes: "positioning notes",
  answerStyle: "answer style",
  profile: "profile",
  globalRules: "global rules",
} as const;

type Chunk = { title: string; hash: string };
export type Snapshot = {
  version: string;
  files: Record<keyof typeof fileLabels, string>;
  chunks: Record<string, Chunk>;
};

/** Compare exported entry hashes, using the new title except for removed entries. */
export function diffSnapshots(old: Snapshot, next: Snapshot): string[] {
  const changes: string[] = [];
  for (const [id, chunk] of Object.entries(next.chunks)) {
    const previous = Object.hasOwn(old.chunks, id) ? old.chunks[id] : undefined;
    if (!previous) changes.push(`added ${id} — ${chunk.title}`);
    else if (previous.hash !== chunk.hash || previous.title !== chunk.title)
      changes.push(`changed ${id} — ${chunk.title}`);
  }
  for (const [id, chunk] of Object.entries(old.chunks)) {
    if (!Object.hasOwn(next.chunks, id)) changes.push(`removed ${id} — ${chunk.title}`);
  }
  for (const key of Object.keys(fileLabels) as (keyof typeof fileLabels)[]) {
    if (old.files[key] !== next.files[key]) changes.push(`changed file: ${fileLabels[key]}`);
  }
  return changes.length ? changes : ["no changes"];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateChunks(value: unknown): asserts value is Snapshot["chunks"] {
  if (!isObject(value) || Object.entries(value).some(([id, chunk]) =>
    !isText(id) || !isObject(chunk) || !isText(chunk.title) || !isText(chunk.hash))) {
    throw new Error("Invalid chunks: expected an ID-keyed object with title and hash for every entry");
  }
}

async function readJson(file: string): Promise<unknown> {
  // Do not include JSON parser errors: they can quote source content.
  const text = await readFile(file, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${path.basename(file)}`);
  }
}

async function readSnapshot(file: string): Promise<Snapshot> {
  const value = await readJson(file);
  if (!isObject(value) || !isText(value.version) || !isObject(value.files))
    throw new Error("Invalid published snapshot: expected version, files, and chunks");
  for (const key of Object.keys(fileLabels)) {
    if (typeof value.files[key] !== "string")
      throw new Error(`Invalid published snapshot: missing file hash for ${fileLabels[key as keyof typeof fileLabels]}`);
  }
  validateChunks(value.chunks);
  return value as Snapshot;
}

async function takeSnapshot(dir: string): Promise<Snapshot> {
  const corpus = await loadCorpus(dir);
  const manifest = await readJson(path.join(dir, "corpus.json"));
  // loadCorpus validates the manifest. A report additionally needs the export's
  // entry index; silently treating a missing index as empty would hide changes.
  if (!isObject(manifest) || !isText(manifest.documentsFrom))
    throw new Error("corpus.json: documentsFrom must point to bot-export.json for a change report");
  const exported = await readJson(path.resolve(dir, manifest.documentsFrom));
  if (!isObject(exported)) throw new Error("Invalid bot-export.json: missing chunks");
  // career-source writes chunks as a list of {id, title, file, hash}; snapshots key them by ID.
  const chunks = Array.isArray(exported.chunks)
    ? Object.fromEntries(exported.chunks.map((c: unknown) =>
        isObject(c) && isText(c.id) ? [c.id, { title: c.title, hash: c.hash }] : ["", c]))
    : exported.chunks;
  validateChunks(chunks);
  const { version, files } = corpusSnapshot(corpus);
  return { version, files, chunks };
}

async function main(args: string[]): Promise<void> {
  const usage = "Usage: corpus-report.ts <corpusDir> [--against <published.json>] [--write <published.json>]";
  const [dir, ...flags] = args;
  if (!dir || dir.startsWith("--")) throw new Error(usage);
  const options: { against?: string; write?: string } = {};
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const value = flags[i + 1];
    if ((flag !== "--against" && flag !== "--write") || !value || value.startsWith("--"))
      throw new Error(usage);
    const key = flag === "--against" ? "against" : "write";
    if (options[key]) throw new Error(usage);
    options[key] = value;
  }
  const current = await takeSnapshot(path.resolve(dir));
  const changes = options.against ? diffSnapshots(await readSnapshot(options.against), current) : [];
  if (options.write) await writeFile(options.write, JSON.stringify(current, null, 2) + "\n");
  console.log(`version ${current.version}`);
  for (const change of changes) console.log(change);
}

// Importing diffSnapshots in tests must not run the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Corpus report failed");
    process.exitCode = 1;
  });
}
