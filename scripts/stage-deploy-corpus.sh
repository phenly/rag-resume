#!/usr/bin/env bash
# Copy a corpus folder into deploy-corpus/ (gitignored) with every document flattened
# beside the manifest, so a Vercel deploy can bundle it. Usage:
#   scripts/stage-deploy-corpus.sh <corpus-dir> [output-dir]
set -euo pipefail

src="${1:?usage: stage-deploy-corpus.sh <corpus-dir> [output-dir]}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
out="${2:-$repo/deploy-corpus}"

rm -rf "$out"
mkdir -p "$out"

node - "$src" "$out" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const [src, out] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(src, "corpus.json"), "utf8"));
const copy = (rel, name, base = src) => {
  fs.copyFileSync(path.resolve(base, rel), path.join(out, name));
  return name;
};
manifest.profile = copy(manifest.profile, "profile.json");
manifest.positioningNotes = copy(manifest.positioningNotes, "positioning-notes.md");
if (manifest.answerStyle !== undefined) {
  manifest.answerStyle = copy(manifest.answerStyle, "answer-style.md");
}
let documentCount = 0;
const copyDocuments = (documents, base) => documents.map((d) => ({
  title: d.title,
  path: copy(d.path, `doc-${++documentCount}.md`, base),
}));
manifest.documents = copyDocuments(manifest.documents, src);
if (manifest.documentsFrom !== undefined) {
  const exportPath = path.resolve(src, manifest.documentsFrom);
  const exportDir = path.dirname(exportPath);
  const exported = JSON.parse(fs.readFileSync(exportPath, "utf8"));
  exported.documents = copyDocuments(exported.documents, exportDir);
  exported.rules = copy(exported.rules, "global-rules.md", exportDir);
  manifest.documentsFrom = "bot-export.json";
  fs.writeFileSync(path.join(out, manifest.documentsFrom), JSON.stringify(exported, null, 2) + "\n");
}
const profile = JSON.parse(fs.readFileSync(path.join(out, "profile.json"), "utf8"));
if (profile.photo) {
  const name = `photo${path.extname(profile.photo)}`;
  copy(profile.photo, name);
  profile.photo = name;
  fs.writeFileSync(path.join(out, "profile.json"), JSON.stringify(profile, null, 2) + "\n");
}
fs.writeFileSync(path.join(out, "corpus.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Staged ${documentCount} documents into ${out}`);
JS
