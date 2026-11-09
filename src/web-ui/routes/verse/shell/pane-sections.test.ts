import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PANE_SECTIONS, sectionForPane } from './pane-sections.js';

const verseDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every pane id declared by a *.pane.tsx file under routes/verse (file name when the id is a shared constant). */
function paneIdsOnDisk(): string[] {
  return readdirSync(verseDir, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) =>
    readdirSync(join(verseDir, d.name)).filter((f) => f.endsWith('.pane.tsx'))
      .map((f) => /\bid:\s*'([^']+)'/.exec(readFileSync(join(verseDir, d.name, f), 'utf8'))?.[1] ?? f.replace('.pane.tsx', '')));
}

describe('sectionForPane', () => {
  it('keeps the MetaMuse section order', () => {
    expect(PANE_SECTIONS.map((s) => s.label)).toEqual(['Chat', 'Feed', 'Ideas', 'Goals', 'Library', 'Fleet']);
  });

  it('maps every pane on disk to a known section', () => {
    const ids = paneIdsOnDisk();
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) {
      expect(PANE_SECTIONS.map((s) => s.id), id).toContain(sectionForPane(id));
    }
  });

  it('places the named panes', () => {
    expect(['leader-thread', 'leader-journal'].map(sectionForPane)).toEqual(['chat', 'chat']);
    expect(['feed', 'fleet-events', 'fleet-timeline', 'fleet-bus'].map(sectionForPane)).toEqual(['feed', 'feed', 'feed', 'feed']);
    expect([sectionForPane('ideas'), sectionForPane('goals'), sectionForPane('library')]).toEqual(['ideas', 'goals', 'library']);
    expect(sectionForPane('fleet-queue')).toBe('fleet');
  });

  it('sends unknown ids (including prototype keys) to Fleet', () => {
    expect(sectionForPane('brand-new-pane')).toBe('fleet');
    expect(sectionForPane('constructor')).toBe('fleet');
  });
});
