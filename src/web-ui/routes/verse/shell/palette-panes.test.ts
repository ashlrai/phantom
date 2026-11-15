import { expect, it } from 'vitest';
import { listPanes, registerPane } from '../panes/index.js';
import { buildPaletteItems, paletteView, type PaletteInput } from './palette-model.js';

const input = (panes: ReturnType<typeof listPanes>): PaletteInput => ({
  panes, needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac',
});

it('offers an open action for every registered pane, including newly registered panes', () => {
  const unregister = registerPane({ id: 'future-pane', title: 'Future pane', icon: () => null, component: () => null });
  try {
    const panes = listPanes();
    expect(panes.length).toBeGreaterThan(1);
    const items = buildPaletteItems(input(panes));
    for (const pane of panes) {
      const item = items.find((candidate) => candidate.key === `pane:${pane.id}`);
      expect(item, pane.id).toMatchObject({
        title: `Open pane: ${pane.title}`,
        group: 'panes',
        payload: { kind: 'pane', paneId: pane.id },
      });
      expect(paletteView(items, pane.title, [], 'mac').flat.some((candidate) => candidate.key === item?.key), pane.id).toBe(true);
    }
  } finally {
    unregister();
  }
});

it('makes pane descriptions and goal synonyms searchable', () => {
  const items = buildPaletteItems(input(listPanes()));
  expect(paletteView(items, 'vision', [], 'mac').flat.some((item) => item.key === 'pane:goals')).toBe(true);
  expect(paletteView(items, 'milestone', [], 'mac').flat.some((item) => item.key === 'pane:goals')).toBe(true);
});
