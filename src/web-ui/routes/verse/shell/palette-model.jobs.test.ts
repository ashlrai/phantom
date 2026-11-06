import { expect, it } from 'vitest';
import { buildPaletteItems, paletteView, type PaletteInput, type PaletteWorker } from './palette-model.js';

const now = Date.parse('2026-10-31T05:00:00Z');
const input = (workers: PaletteWorker[]): PaletteInput => ({ workers, needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac', now });
const view = (workers: PaletteWorker[], query = '@RQ-PHX-X') => paletteView(buildPaletteItems(input(workers)), query, [], 'mac');
const workers: PaletteWorker[] = [
  { job: 'RQ-PHX-X-MERGED', lane: 'codex-personal', tier: '', ageSeconds: null, state: 'merged', at: '2026-10-31T04:40:00Z', prUrl: 'https://github.com/ashlrai/phantom/pull/1811' },
  { job: 'RQ-PHX-X-QUEUE', lane: 'codex-personal', tier: 'mid', ageSeconds: null, state: 'queued', at: null, prUrl: null },
  { job: 'RQ-PHX-X-RUN', lane: 'codex-personal', tier: 'mid', ageSeconds: 720, state: 'running', at: null, prUrl: null },
];

it('shows state descriptions in running, queued, merged order and selects a merged PR', () => {
  const rows = view(workers).flat;
  expect(rows.map(row => row.subtitle)).toEqual(['running · 12 min · codex-personal', 'queued · codex-personal/mid', 'merged 20m ago · PR #1811']);
  expect(rows[2]?.payload).toEqual({ kind: 'worker', job: 'RQ-PHX-X-MERGED', url: 'https://github.com/ashlrai/phantom/pull/1811', selectLog: true });
  expect(view(workers, '@codex-personal').flat).toHaveLength(3);
});
it('shows no workers group for an empty snapshot', () => {
  expect(view([]).groups.some(group => group.id === 'workers')).toBe(false);
});
it('allows up to 50 stateful jobs with @', () => {
  expect(view(Array.from({ length: 60 }, (_, i) => ({ ...workers[1]!, job: `RQ-PHX-X-${i}` })), '@').flat).toHaveLength(50);
});
