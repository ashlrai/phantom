import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetOutcomesPane } from './FleetOutcomesPane.js';

const now = Date.parse('2026-11-01T05:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows the published jobs, merge waits, and summary', async () => {
  const runs = { publishesLastHour: [
    { job: 'RQ-MERGED', lane: 'codex', url: 'https://github.com/ashlrai/phantom/pull/42', at: ago(40) },
    { job: 'RQ-WAITING', lane: 'claude', url: 'https://github.com/ashlrai/phantom/pull/43', at: ago(70) },
  ], mergesLastHour: { items: [{ repo: 'ashlrai/phantom', number: 42, mergedAt: ago(18) }] } };
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => Response.json(String(url).includes('/fleet/runs') ? runs
    : { v: 1, state: 'current', feedback: { sourceState: 'healthy', complete: true, cases: [] } })));
  render(<FleetOutcomesPane {...({ visible: true } as PaneProps)} />);
  const section = within(await screen.findByRole('region', { name: 'Merge wait (last hour)' }));
  expect(await section.findByText('1 merged, median 22m · 1 waiting, oldest 70m')).toBeInTheDocument();
  const rows = section.getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('RQ-WAITING claude #43 waiting 70m');
  expect(within(rows[0]!).getByText('waiting 70m')).toHaveAttribute('data-tone', 'bad');
  expect(within(rows[0]!).getByRole('link', { name: '#43' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/43');
  expect(rows[1]).toHaveTextContent('RQ-MERGED codex #42 merged after 22m');
  expect(within(rows[1]!).getByRole('link', { name: '#42' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');
});
