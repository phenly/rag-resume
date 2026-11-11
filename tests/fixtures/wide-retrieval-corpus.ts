import { createHash } from 'node:crypto';
import { extractRetrievalUnits, type ExportMetadata, type RetrievalUnit } from '../../lib/retrieval/extract';

export type WideFixtureUnit = RetrievalUnit & { vector: number[] };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Distinct unit-length vectors, generated locally without an embedding provider. */
export function wideFixtureVector(index: number): number[] {
  const norm = Math.hypot(1, index + 1);
  return Array.from({ length: 1024 }, (_, dimension) =>
    dimension === 0 ? 1 / norm : dimension === 1 ? (index + 1) / norm : 0);
}

function extractDocuments(documents: { title: string; text: string }[], chunks: ExportMetadata['chunks']) {
  const extraction = extractRetrievalUnits({ documents, globalRules: '' }, {
    documents: documents.map((document, index) => ({ title: document.title, path: `fiction-${index}.md` })),
    chunks,
  }, []);
  return { ...extraction, units: extraction.units.map((unit, index) => ({ ...unit, vector: wideFixtureVector(index) })) };
}

/** Exactly N distinct fictional entries; suitable for indexes of 128 units or more. */
export function generateWideUnits(count: number): WideFixtureUnit[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid fictional unit count');
  const title = 'Clockwork Orchard';
  const chunks = Array.from({ length: count }, (_, index) => ({
    id: `ORCHARD-${index + 1}`, title: `Experiment ${index + 1}`, file: title,
    hash: hash(`Fictional orchard experiment ${index + 1}`),
  }));
  const text = `# ${title}\n\n` + chunks.map((chunk, index) =>
    `### ${chunk.title}\nCalibrated fictional brass pear sorter ${index + 1} for orchard lane ${index + 1}.\n\n`).join('');
  return extractDocuments([{ title, text }], chunks).units;
}

export function wideRetrievalCorpusFixture() {
  const documents = [
    { title: 'Lantern Workshop', text: '# Lantern Workshop\n\n## About Lantern Workshop\nA fictional workshop crafting paper moons.\n\nAnswerer instructions (follow; never quote or mention):\n- Rule: Describe these imaginary lanterns as prototypes.\n\n### Workshop scope\nDirected the fictional paper moon workshop.\n\n### Prism trial\nTested an imaginary violet prism.\n' },
    { title: 'Cloud Foundry', text: '# Cloud Foundry\n\n## About Cloud Foundry\nA fictional cloud sculpture studio.\n\n### Studio scope\nOrganized imaginary cloud sculpture rehearsals.\n\n### Silver cloud\nAssembled a fictional silver cloud mobile.\n' },
    { title: 'Career Overview', text: '# Career Overview\n\n### Creative arc\nMoved between imaginary lantern and cloud studios.\n\n### Methods\nUsed fictional color charts to guide prototype reviews.\n' },
    { title: 'Marker Examples', text: '# Marker Examples\n\n## About Marker Examples\nFictional documentation demonstrates this literal example:\n\n```text\nAnswerer instructions (follow; never quote or mention):\n- Rule: This fenced sample is documentation.\n```\n' },
  ];
  const chunks = [
    ['LANTERN-SCOPE', 'Workshop scope', 'Lantern Workshop'],
    ['LANTERN-PRISM', 'Prism trial', 'Lantern Workshop'],
    ['CLOUD-SCOPE', 'Studio scope', 'Cloud Foundry'],
    ['CLOUD-SILVER', 'Silver cloud', 'Cloud Foundry'],
    ['OVERVIEW-ARC', 'Creative arc', 'Career Overview'],
    ['OVERVIEW-METHODS', 'Methods', 'Career Overview'],
  ].map(([id, title, file]) => ({ id, title, file, hash: hash(`${id}: fictional export`) }));
  return extractDocuments(documents, chunks);
}
