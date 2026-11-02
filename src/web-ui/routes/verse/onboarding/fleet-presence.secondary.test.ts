import { expect, it } from 'vitest';
import { whatsNewCopy } from './fleet-presence.js';

it.each([
  ['present', 'Open Lanes, Merges and Queue as dock panes with /pane.', { label: 'Open fleet workspace', action: 'fleet-workspace' }, { label: 'Tell the leaders', action: 'interject' }],
  ['missing', 'Open dock panes with /pane; ⌘/ lists keyboard shortcuts.', { label: 'Open Settings ▸ Fleet sources', action: 'fleet-sources' }, null],
  ['unknown', 'Open dock panes with /pane; ⌘/ lists keyboard shortcuts.', { label: 'Open Settings', action: 'settings' }, null],
] as const)('offers the correct actions for %s', (presence, firstBullet, primary, secondary) => {
  const copy = whatsNewCopy(presence);
  expect(copy.bullets[0]).toBe(firstBullet);
  expect(copy.primary).toEqual(primary);
  expect(copy.secondary).toEqual(secondary);
});
