import { createHash } from "node:crypto";
import type { Corpus, Profile } from "./corpus";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

function profileWithoutPhoto(profile: Profile): Omit<Profile, "photo"> {
  const content = { ...profile };
  delete content.photo;
  return content;
}

/** Hash content, never storage paths: vault and deploy copies must agree. */
export function corpusVersion(
  c: Omit<Corpus, "version" | "photoPath">,
  photoBytes: Buffer | null,
): string {
  return sha256(JSON.stringify([
    profileWithoutPhoto(c.profile),
    photoBytes === null ? null : sha256(photoBytes),
    c.answerStyle,
    c.positioningNotes,
    c.globalRules ?? null,
    c.documents.map((d) => [d.title, d.text]),
  ]));
}

/** Component hashes for change reports; the version also accounts for photo bytes. */
export function corpusSnapshot(c: Corpus): {
  version: string;
  files: Record<"profile" | "answerStyle" | "positioningNotes" | "globalRules", string>;
  documents: Record<string, string>;
} {
  return {
    version: c.version,
    files: {
      profile: sha256(JSON.stringify(profileWithoutPhoto(c.profile))),
      answerStyle: sha256(c.answerStyle),
      positioningNotes: sha256(c.positioningNotes),
      globalRules: sha256(c.globalRules ?? ""),
    },
    documents: Object.fromEntries(c.documents.map((d) => [d.title, sha256(d.text)])),
  };
}
