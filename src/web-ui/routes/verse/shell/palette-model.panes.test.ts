import { expect, it } from 'vitest';
import { buildPaletteItems, paletteView, type PaletteInput } from './palette-model.js';

const input: PaletteInput = {
  needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac',
  panes: [{ id: 'merges', title: 'Merges' }, { id: 'worker-log', title: 'Worker log', keywords: ['output'] }],
};
it('builds registered panes with title, id words and optional keywords', () => {
  const panes = buildPaletteItems(input).filter((item) => item.group === 'panes');
  expect(panes.map((item) => [item.key, item.title, item.payload])).toEqual([
    ['pane:merges', 'Open pane: Merges', { kind: 'pane', paneId: 'merges' }],
    ['pane:worker-log', 'Open pane: Worker log', { kind: 'pane', paneId: 'worker-log' }],
  ]);
  expect(panes[1]!.keywords).toEqual(['Worker log', 'worker', 'log', 'output']);
});
it.each(['merges', 'worker log'])('puts the named pane first for %s', (query) => {
  const view = paletteView(buildPaletteItems(input), query, [], 'mac');
  expect(view.groups[0]!.id).toBe('panes');
  expect(view.flat[0]!.title).toBe(`Open pane: ${query === 'merges' ? 'Merges' : 'Worker log'}`);
  expect(view.best).toBe(0);
});
it('caps pane search results at 50 and resolves recent pane actions', () => {
  const items = buildPaletteItems({ ...input, panes: Array.from({ length: 60 }, (_, i) => ({ id: `sample-${i}`, title: `Sample ${i}` })) });
  expect(paletteView(items, 'sample', [], 'mac').groups.find((group) => group.id === 'panes')!.items).toHaveLength(50);
  const recent = paletteView(items, '', ['pane.sample-4'], 'mac');
  expect(recent.flat[0]!.payload).toEqual({ kind: 'pane', paneId: 'sample-4' });
  expect(paletteView(items, '>', [], 'mac').groups.some((group) => group.id === 'panes')).toBe(false);
});
