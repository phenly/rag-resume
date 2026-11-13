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
    expect(t).not.toContain('whole archive');
  });

  it('jev discloses both search services and the whole-archive fallback', () => {
    const t = text('jev');
    expect(t).toContain('Voyage AI receives your question');
    expect(t).toContain('TypeSafe receives the question');
    expect(t).toContain('whole archive');
  });

  it('no mode claims answers list their sources, and each has four boxes and steps', () => {
    for (const mode of ['whole', 'wide', 'jev'] as const) {
      const copy = howItWorksCopy(mode);
      expect(copy.boxes).toHaveLength(4);
      expect(copy.steps).toHaveLength(4);
      expect(text(mode)).not.toMatch(/sources|which material it used/);
    }
  });
});
