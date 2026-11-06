import { expect, it } from 'vitest';
import { buildPaletteItems, paletteView, type PaletteInput, type PaletteWorker } from './palette-model.js';

const worker: PaletteWorker = { job: 'RQ-PHX-WORKERCHANGES31', lane: 'phx-lane', tier: 'codex-personal', ageSeconds: 720, prUrl: null };
const input = (workers: PaletteWorker[]): PaletteInput => ({ workers, needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac' });
const view = (query: string, workers = [worker]) => paletteView(buildPaletteItems(input(workers)), query, [], 'mac');

it('finds job fragments and lane keywords in Workers', () => {
  for (const query of ['phx-work', 'phx-lane']) {
    expect(view(query).groups.find(g => g.id === 'workers')?.items[0]).toMatchObject({ kind: 'worker', title: worker.job, subtitle: 'phx-lane · codex-personal · 12 min' });
  }
});
it('restricts @ to workers and keeps the empty palette unchanged', () => {
  expect(view('@').groups.map(g => g.id)).toEqual(['workers']);
  expect(view('').flat.some(i => i.kind === 'worker')).toBe(false);
  expect(view('   ').flat.some(i => i.kind === 'worker')).toBe(false);
});
it('caps workers at eight, including @, with oldest first for equal matches', () => {
  const workers = Array.from({ length: 12 }, (_, i) => ({ ...worker, job: `RQ-PHX-WORK-${i}`, ageSeconds: i * 60 }));
  for (const query of ['@', 'phx-work']) {
    const items = view(query, workers).groups.find(g => g.id === 'workers')!.items;
    expect(items).toHaveLength(8);
    expect(items[0]?.title).toBe('RQ-PHX-WORK-11');
  }
});
it('emits a PR sibling only for HTTPS URLs', () => {
  expect(view('@').flat).toHaveLength(1);
  for (const prUrl of ['http://github.com/x/y/pull/1719', 'javascript:alert(1)', 'bad']) expect(view('@', [{ ...worker, prUrl }]).flat).toHaveLength(1);
  expect(view('@', [{ ...worker, prUrl: 'https://github.com/x/y/pull/1719' }]).flat[1]).toMatchObject({ title: `Open PR #1719 for ${worker.job}`, payload: { kind: 'worker', url: 'https://github.com/x/y/pull/1719' } });
});
