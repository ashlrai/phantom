import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetOutcomesPane } from './FleetOutcomesPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([[9, 'neutral'], [10, 'warn'], [19, 'warn'], [20, 'bad']])('shows the waste line with %i of 40 wasted as %s', async (wasted, tone) => {
  const cases = Array.from({ length: 40 }, (_, n) => ({ caseId: `fake-${n}`,
    endedAt: new Date().toISOString(), outcome: n < wasted ? 'failed' : 'producer-succeeded' }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ v: 1, state: 'current', feedback: {
    sourceState: 'healthy', complete: true, cases,
    counts: { failed: wasted, 'producer-succeeded': 40 - wasted },
  } })));
  render(<FleetOutcomesPane {...({ visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps)} />);
  const line = await screen.findByText(new RegExp(`^Waste, last 24 h: ${wasted} of 40 finished cases`));
  expect(line).toHaveAttribute('data-tone', tone);
  expect(line).toHaveTextContent(`Lane or producer not recorded (${wasted}).`);
  expect(line.tagName).toBe('P');
});
