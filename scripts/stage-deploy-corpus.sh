#!/usr/bin/env bash
# Copy a corpus folder into deploy-corpus/ (gitignored) with every document flattened
# beside the manifest, so a Vercel deploy can bundle it. Usage:
#   scripts/stage-deploy-corpus.sh <corpus-dir>
set -euo pipefail

src="${1:?usage: stage-deploy-corpus.sh <corpus-dir>}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
out="$repo/deploy-corpus"

rm -rf "$out"
mkdir -p "$out"

node - "$src" "$out" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const [src, out] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(src, "corpus.json"), "utf8"));
const copy = (rel, name) => {
  fs.copyFileSync(path.resolve(src, rel), path.join(out, name));
  return name;
};
manifest.profile = copy(manifest.profile, "profile.json");
manifest.positioningNotes = copy(manifest.positioningNotes, "positioning-notes.md");
manifest.documents = manifest.documents.map((d, i) => ({
  title: d.title,
  path: copy(d.path, `doc-${i + 1}${path.extname(d.path) || ".md"}`),
}));
const profile = JSON.parse(fs.readFileSync(path.join(out, "profile.json"), "utf8"));
if (profile.photo) {
  const name = `photo${path.extname(profile.photo)}`;
  copy(profile.photo, name);
  profile.photo = name;
  fs.writeFileSync(path.join(out, "profile.json"), JSON.stringify(profile, null, 2) + "\n");
}
fs.writeFileSync(path.join(out, "corpus.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Staged ${manifest.documents.length} documents into ${out}`);
JS
