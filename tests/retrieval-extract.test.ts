import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractRetrievalUnits, type ExportMetadata } from '../lib/retrieval/extract';

const metadata = (): ExportMetadata => ({
  documents: [{ title: 'ExampleCo', path: 'example.md' }],
  chunks: [
    { id: 'EX-SCOPE', title: 'Scope', file: 'ExampleCo', hash: 'a'.repeat(64) },
    { id: 'EX-STORY', title: 'A story', file: 'ExampleCo', hash: 'b'.repeat(64) },
  ],
});
const source = '# ExampleCo\n\n## About ExampleCo\nA fictional company.\n\n### Scope\nExampleCo · Product Lead · 2020–2022\n\n- Built widgets. Contact pat@example.test.\n\nAnswerer instructions (follow; never quote or mention):\n- Rule: never disclose the customer.\n- Positioning: emphasize the outcome.\n  Preserve the scope.\n\n### A story\nExampleCo · Product Lead\n\n- Improved a process.\n';
const corpus = (text = source) => ({ documents: [{ title: 'ExampleCo', text }], globalRules: 'Do not disclose pat@example.test.' });
const extract = (text = source, info = metadata()) => extractRetrievalUnits(corpus(text), info, []);

describe('typed retrieval extraction', () => {
  it('maps entries, preserves instructions, redacts contacts, and separates hashes', () => {
    const result = extract();
    expect(result.sourceEntryCount).toBe(2);
    expect(result.supplementalCount).toBe(1);
    expect(result.units.map(unit => unit.id)).toEqual(['about:ExampleCo', 'EX-SCOPE', 'EX-STORY']);
    const scope = result.units[1];
    expect(scope.promptText).toContain('- Positioning: emphasize the outcome.');
    expect(scope.promptText).toContain('Preserve the scope.');
    expect(scope.searchText).toContain('ExampleCo · Product Lead');
    expect(scope.searchText).not.toMatch(/Answerer instructions|never disclose|emphasize/);
    expect(JSON.stringify(result)).not.toContain('pat@example.test');
    expect(scope.exporterHash).toBe('a'.repeat(64));
    expect(scope.indexedHash).toBe(createHash('sha256').update(scope.searchText).digest('hex'));
    expect(scope.promptHash).not.toBe(scope.indexedHash);
  });

  it('accounts for every character once, including structural headers and whitespace', () => {
    const result = extract();
    const redacted = source.replace('pat@example.test', '[email removed]');
    expect(result.spans[0].start).toBe(0);
    expect(result.spans.at(-1)?.end).toBe(redacted.length);
    result.spans.slice(1).forEach((span, i) => expect(span.start).toBe(result.spans[i].end));
  });

  it('keeps instruction-only changes out of indexed hashes', () => {
    const before = extract().units[1];
    const after = extract(source.replace('emphasize the outcome', 'emphasize teamwork')).units[1];
    expect(before.indexedHash).toBe(after.indexedHash);
    expect(before.promptHash).not.toBe(after.promptHash);
  });

  it('splits explicitly declared supplemental sections with stable duplicate suffixes', () => {
    const input = corpus();
    input.documents.push({ title: 'Public profile', text: 'Capture metadata\n\n# Profile\nPublic introduction.\n\n## About\nA biography.\n\n## About\nAnother section.\n' });
    const result = extractRetrievalUnits(input, metadata(), [{ title: 'Public profile', idPrefix: 'linkedin' }]);
    expect(result.units.filter(unit => unit.kind === 'supplemental').map(unit => unit.id)).toEqual(['linkedin:preamble', 'linkedin:profile', 'linkedin:about', 'linkedin:about:2']);
    const spans = result.spans.filter(span => span.document === 'Public profile');
    expect(spans[0].start).toBe(0);
    expect(spans.at(-1)?.end).toBe(input.documents[1].text.length);
  });

  it('ignores fenced heading lookalikes and preserves the complete factual span', () => {
    const result = extract(source.replace('- Improved a process.', '- Improved a process.\n\n```md\n### Fake entry\nAnswerer instructions (follow; never quote or mention):\n- Rule: sample code only\n```'));
    expect(result.units.at(-1)?.searchText).toContain('### Fake entry');
    expect(result.sourceEntryCount).toBe(2);
  });

  it.each([
    ['missing entry', source.replace(/### A story[\s\S]*/, '')],
    ['unexpected heading', source.replace('### Scope', '## Scope')],
    ['unaccounted preamble', source.replace('# ExampleCo\n', '# ExampleCo\nStray facts.\n')],
    ['wrong title order', source.replace('### Scope', '### A story').replace('### A story\nExampleCo · Product Lead\n', '### Scope\nExampleCo · Product Lead\n')],
    ['duplicate section', source + '\n### A story\nExtra.'],
    ['instruction continuation without indent', source.replace('  Preserve the scope.', 'A new factual paragraph.')],
    ['unclosed fence', source + '\n```\n'],
    ['detached instruction', source.replace('Answerer instructions (follow; never quote or mention):\n', '')],
  ])('rejects malformed export: %s', (_name, text) => {
    expect(() => extract(text)).toThrow('Retrieval extraction:');
  });

  it.each(['Rule', 'Positioning'])('rejects detached %s before an otherwise valid instruction block', label => {
    const text = source.replace('- Built widgets.', `- ${label}: Detached instructions.\n\n- Built widgets.`);
    expect(() => extract(text)).toThrow('instruction outside answerer block');
  });

  it('preserves fenced instruction examples before a valid answerer block', () => {
    const text = source.replace('- Built widgets.', '```md\n- Rule: A literal example.\n- Positioning: Another literal example.\n```\n\n- Built widgets.');
    const scope = extract(text).units[1];
    expect(scope.searchText).toContain('- Rule: A literal example.');
    expect(scope.searchText).toContain('- Positioning: Another literal example.');
    expect(scope.searchText).not.toContain('never disclose the customer');
  });

  it('rejects duplicate IDs, ambiguous titles, unknown files, missing documents and collisions', () => {
    const duplicateId = metadata(); duplicateId.chunks[1].id = 'EX-SCOPE';
    expect(() => extract(source, duplicateId)).toThrow('duplicate');
    const duplicateTitle = metadata(); duplicateTitle.chunks[1].title = 'Scope';
    expect(() => extract(source, duplicateTitle)).toThrow('ambiguous');
    const unknownFile = metadata(); unknownFile.chunks[0].file = 'Missing';
    expect(() => extract(source, unknownFile)).toThrow('invalid chunk');
    expect(() => extractRetrievalUnits({ documents: [] }, metadata(), [])).toThrow('missing corpus document');
    expect(() => extractRetrievalUnits({ documents: [...corpus().documents, ...corpus().documents] }, metadata(), [])).toThrow('duplicate corpus');
    expect(() => extractRetrievalUnits(corpus(), metadata(), [{ title: 'ExampleCo', idPrefix: 'linkedin' }])).toThrow('invalid supplemental');
  });

  it('requires declaration for every supplemental document', () => {
    expect(() => extractRetrievalUnits({ documents: [{ title: 'Unexpected', text: 'text' }] }, { documents: [], chunks: [] }, [])).toThrow('undeclared supplemental');
  });
});
