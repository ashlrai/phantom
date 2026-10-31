import { expect, it } from 'vitest';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { paletteLanes } from './palette-lanes.js';
import { buildPaletteItems, paletteView } from './palette-model.js';

it('groups lane commands and matches pause personal', () => {
  const items = buildPaletteItems({
    lanes: paletteLanes(fleetRunsFixture(), {}), needsYou: [], running: [], sessions: [],
    seats: [], projects: [], recentActions: [], platform: 'mac',
  });
  expect(items.filter(item => item.kind === 'lane')).toHaveLength(2);
  const view = paletteView(items, 'pause personal', [], 'mac');
  expect(view.groups.find(group => group.id === 'lanes')?.label).toBe('Lanes');
  expect(view.flat[view.best]).toMatchObject({
    kind: 'lane', title: 'Lane codex-personal: 3/4 running · pause',
    payload: { kind: 'lane', lane: { lane: 'codex-personal' } },
  });
});
