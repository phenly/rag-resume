import { createHash } from 'node:crypto';
import type { Corpus } from '../corpus';
import { redactContacts } from '../redact';

export type ExportMetadata = {
  documents: { title: string; path: string }[];
  chunks: { id: string; title: string; file: string; hash: string }[];
};
export type RetrievalUnit = {
  id: string;
  kind: 'entry' | 'about' | 'supplemental';
  document: string;
  title: string;
  /** Complete post-redaction source span, including attached answerer instructions. */
  promptText: string;
  /** Exact embedding/BM25 input: factual source span without answerer instructions. */
  searchText: string;
  exporterHash?: string;
  indexedHash: string;
  promptHash: string;
};
export type SourceSpan = {
  document: string;
  /** Zero-based character offsets into the post-redaction document. End is exclusive. */
  start: number;
  end: number;
  kind: RetrievalUnit['kind'] | 'structural';
  unitId?: string;
};
export type Extraction = {
  units: RetrievalUnit[];
  spans: SourceSpan[];
  sourceEntryCount: number;
  supplementalCount: number;
  globalRules: string;
};

type Heading = { start: number; end: number; level: number; title: string };
const INSTRUCTIONS = 'Answerer instructions (follow; never quote or mention):';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fail = (message: string): never => { throw new Error(`Retrieval extraction: ${message}`); };
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0;

/** Ignore heading-like text inside fenced code; reject unclosed fences rather than losing sections. */
function headings(text: string): Heading[] {
  const result: Heading[] = [];
  let fence: { char: string; length: number } | undefined;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(bare);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (!fence) {
      const match = /^(#{1,6}) ([^\r\n]+)$/.exec(bare);
      if (match) result.push({ start: offset, end: offset + line.length, level: match[1].length, title: match[2] });
    }
    offset += line.length;
  }
  if (fence) fail('unclosed fenced block');
  return result;
}

function factualText(promptText: string): string {
  const lines = promptText.split(/\r?\n/);
  let fence: { char: string; length: number } | undefined;
  const instructionLines: number[] = [];
  const outside: { line: string; index: number }[] = [];
  lines.forEach((line, index) => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match) {
      if (!fence) fence = { char: match[1][0], length: match[1].length };
      else if (match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
    } else if (!fence) {
      outside.push({ line, index });
      if (line === INSTRUCTIONS) instructionLines.push(index);
    }
  });
  if (instructionLines.length > 1) fail('duplicate answerer block');
  const marker = instructionLines[0] ?? -1;
  if (outside.some(({ line, index }) => (marker === -1 || index < marker) && /^\s*(?:-\s*)?(?:Rule|Positioning):/.test(line))) fail('instruction outside answerer block');
  if (marker === -1) return promptText;
  // Exported instruction blocks contain bullets and optional indented continuation lines only.
  let hasInstruction = false;
  for (const line of lines.slice(marker + 1)) {
    if (!line.trim()) continue;
    if (/^- (?:Rule|Positioning):\s*\S/.test(line)) hasInstruction = true;
    else if (!(hasInstruction && /^\s+\S/.test(line))) fail('unexpected text in answerer block');
  }
  if (!hasInstruction) fail('empty answerer block');
  return lines.slice(0, marker).join('\n').trimEnd();
}

/**
 * Pure extraction boundary. Pass loadCorpus's exported/redacted snapshot and matching metadata.
 * Every non-export document must be explicitly declared supplemental (e.g. LinkedIn profile).
 * Reapply the existing contact redactor defensively; never read private source files here.
 */
export function extractRetrievalUnits(
  corpus: Pick<Corpus, 'documents' | 'globalRules'>,
  metadata: ExportMetadata,
  supplemental: { title: string; idPrefix: string }[],
): Extraction {
  if (!Array.isArray(metadata.documents) || !Array.isArray(metadata.chunks)) fail('invalid export metadata');
  const labels = new Set<string>();
  const paths = new Set<string>();
  for (const document of metadata.documents) {
    if (!nonempty(document.title) || !nonempty(document.path) || labels.has(document.title) || paths.has(document.path)) fail('duplicate or invalid export document');
    labels.add(document.title); paths.add(document.path);
  }
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const chunk of metadata.chunks) {
    if (!nonempty(chunk.id) || !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(chunk.id) || !nonempty(chunk.title) || !nonempty(chunk.file) || !/^[a-f0-9]{64}$/.test(chunk.hash) || !labels.has(chunk.file)) fail('invalid chunk metadata');
    const key = `${chunk.file}\0${redactContacts(chunk.title)}`;
    if (ids.has(chunk.id) || titles.has(key)) fail('duplicate chunk ID or ambiguous title');
    ids.add(chunk.id); titles.add(key);
  }
  const supplementalMap = new Map<string, string>();
  const prefixes = new Set<string>();
  for (const item of supplemental) {
    if (!nonempty(item.title) || !/^[a-z][a-z0-9-]*$/.test(item.idPrefix) || prefixes.has(item.idPrefix) || labels.has(item.title) || supplementalMap.has(item.title)) fail('invalid supplemental declaration');
    supplementalMap.set(item.title, item.idPrefix); prefixes.add(item.idPrefix);
  }
  const units: RetrievalUnit[] = [];
  const spans: SourceSpan[] = [];
  const seenDocuments = new Set<string>();
  const allUnitIds = new Set<string>();
  const add = (document: string, text: string, start: number, end: number, kind: RetrievalUnit['kind'], id: string, title: string, exporterHash?: string) => {
    if (allUnitIds.has(id)) fail('colliding unit ID');
    allUnitIds.add(id);
    const promptText = text.slice(start, end);
    const searchText = factualText(promptText);
    if (!searchText.trim()) fail('empty factual unit');
    units.push({ id, kind, document: redactContacts(document), title: redactContacts(title), promptText, searchText, exporterHash, indexedHash: hash(searchText), promptHash: hash(promptText) });
    spans.push({ document: redactContacts(document), start, end, kind, unitId: id });
  };
  for (const document of corpus.documents) {
    if (seenDocuments.has(document.title)) fail('duplicate corpus document');
    seenDocuments.add(document.title);
    const text = redactContacts(document.text);
    const sections = headings(text);
    if (labels.has(document.title)) {
      if (!sections.length || sections[0].level !== 1 || sections[0].title !== redactContacts(document.title) || text.slice(0, sections[0].start).trim()) fail('invalid export document header');
      const first = sections[0];
      const preambleEnd = sections[1]?.start ?? text.length;
      if (text.slice(first.end, preambleEnd).trim()) fail('unaccounted export preamble');
      spans.push({ document: redactContacts(document.title), start: 0, end: preambleEnd, kind: 'structural' });
      const expected = metadata.chunks.filter(chunk => chunk.file === document.title);
      let entryIndex = 0;
      for (let i = 1; i < sections.length; i++) {
        const section = sections[i];
        const end = sections[i + 1]?.start ?? text.length;
        if (!text.slice(section.end, end).trim()) fail('empty export section');
        if (section.level === 2 && section.title === `About ${redactContacts(document.title)}` && i === 1) {
          add(document.title, text, section.start, end, 'about', `about:${redactContacts(document.title)}`, section.title);
        } else if (section.level === 3) {
          const entry = expected[entryIndex++];
          if (!entry || section.title !== redactContacts(entry.title)) fail('entry title/order/count mismatch');
          add(document.title, text, section.start, end, 'entry', entry.id, entry.title, entry.hash);
        } else fail('unexpected export heading');
      }
      if (entryIndex !== expected.length) fail('missing exported entries');
    } else {
      const prefix = supplementalMap.get(document.title);
      if (!prefix) fail('undeclared supplemental document');
      // Preserve pre-heading metadata and introductions as explicit units as well.
      const starts = [0, ...sections.map(section => section.start).filter(start => start > 0)];
      const occurrences = new Map<string, number>();
      for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        const end = starts[i + 1] ?? text.length;
        if (!text.slice(start, end).trim()) {
          spans.push({ document: redactContacts(document.title), start, end, kind: 'structural' });
          continue;
        }
        const heading = sections.find(section => section.start === start);
        if (heading && !text.slice(heading.end, end).trim()) {
          spans.push({ document: redactContacts(document.title), start, end, kind: 'structural' });
          continue;
        }
        const title = heading?.title ?? 'Preamble';
        const slug = title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
        const occurrence = (occurrences.get(slug) ?? 0) + 1;
        occurrences.set(slug, occurrence);
        add(document.title, text, start, end, 'supplemental', `${prefix}:${slug}${occurrence > 1 ? `:${occurrence}` : ''}`, title);
      }
    }
  }
  if ([...labels, ...supplementalMap.keys()].some(label => !seenDocuments.has(label))) fail('missing corpus document');
  return {
    units, spans, sourceEntryCount: metadata.chunks.length,
    supplementalCount: units.filter(unit => unit.kind !== 'entry').length,
    globalRules: redactContacts(corpus.globalRules ?? ''),
  };
}
