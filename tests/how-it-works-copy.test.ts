import { describe, expect, it } from 'vitest';
import { howItWorksCopy, howItWorksMode } from '@/lib/how-it-works-copy';

const text = (mode: 'whole' | 'wide' | 'jev') => JSON.stringify(howItWorksCopy(mode));

describe('how it works copy', () => {
  it('describes the configured mode', () => {
    expect(howItWorksMode('whole', 'jev')).toBe('whole');
    expect(howItWorksMode('whole', 'wide')).toBe('whole');
    expect(howItWorksMode('rag', 'wide')).toBe('wide');
    expect(howItWorksMode('rag', 'jev')).toBe('jev');
  });

  it('whole says the full archive is sent and no other service sees questions', () => {
    const t = text('whole');
    expect(t).toContain('entire career archive');
    expect(t).toContain('No other service receives your questions');
    expect(t).not.toContain('TypeSafe');
  });

  it('wide discloses Voyage, never TypeSafe or a whole-archive fallback', () => {
    const t = text('wide');
    expect(t).toContain('Voyage AI receives your question');
    expect(t).not.toContain('TypeSafe');
    expect(t).toContain('No fallback to the whole archive');
  });

  it('jev discloses both search services and the whole-archive fallback', () => {
    const t = text('jev');
    expect(t).toContain('Voyage AI receives your question');
    expect(t).toContain('TypeSafe receives the question');
    expect(t).toContain('whole archive');
  });

  it('no mode claims answers list their sources, and each has a four-box flow under exactly one diagram section', () => {
    for (const mode of ['whole', 'wide', 'jev'] as const) {
      const copy = howItWorksCopy(mode);
      expect(copy.boxes).toHaveLength(4);
      expect(copy.sections.filter((s) => s.diagram)).toHaveLength(1);
      expect(text(mode)).not.toMatch(/which material it used|with its sources/);
    }
  });

  it('whole and jev keep four steps; wide explains indexing, embeddings and what it leaves out', () => {
    expect(howItWorksCopy('whole').sections[0].steps).toHaveLength(4);
    expect(howItWorksCopy('jev').sections[0].steps).toHaveLength(4);
    const wide = howItWorksCopy('wide');
    expect(wide.indexBoxes).toHaveLength(4);
    expect(howItWorksCopy('whole').indexBoxes).toBeUndefined();
    expect(wide.sections.map((s) => s.title)).toEqual([
      'Two jobs, run at different times', 'Before any question: building the index', 'What an embedding is',
      'When you ask a question', 'What it deliberately leaves out', 'How it is tested',
    ]);
    expect(text('wide')).toContain('cosine similarity');
    expect(text('wide')).toContain('No fallback to the whole archive');
  });
});
