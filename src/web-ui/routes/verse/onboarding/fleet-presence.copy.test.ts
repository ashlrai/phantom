import { expect, it } from 'vitest';
import { whatsNewCopy } from './fleet-presence.js';

it.each(['present', 'missing', 'unknown'] as const)('has four concise highlights for %s', presence => {
  const { bullets } = whatsNewCopy(presence);
  expect(bullets).toHaveLength(4);
  for (const bullet of bullets) expect(bullet.length).toBeLessThanOrEqual(90);
  const copy = bullets.join(' ');
  for (const word of presence === 'present' ? ['Inbox', 'panes', 'bell'] : ['Update', 'mobile']) {
    expect(copy).toContain(word);
  }
});
