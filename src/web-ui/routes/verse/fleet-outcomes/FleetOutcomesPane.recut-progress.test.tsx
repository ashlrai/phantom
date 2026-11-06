import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetOutcomesPane } from './FleetOutcomesPane.js';
import { rememberRecut } from './recut-progress-model.js';

const now = Date.parse('2026-11-01T00:10:00Z');
const id = 'RECUT12341101';
const job = `RQ-PHX-${id}`;
const feedback = { v: 1, state: 'current', feedback: { sourceState: 'healthy', cases: [
  { caseId: 'RQ-PHX-EXAMPLE31', outcome: 'failed', prNumber: 1234 },
] } };
let runs: unknown;
const mount = () => render(<FleetOutcomesPane {...({ visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps)} />);
const row = () => within(screen.getByRole('list', { name: 'Cases' })).getByRole('listitem');

beforeEach(() => {
  sessionStorage.clear(); evictAll(); setMutationToken('a'.repeat(64));
  vi.spyOn(Date, 'now').mockReturnValue(now);
  runs = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/verse/fleet/runs') return Response.json(runs);
    if (url === '/api/verse/fleet/live/drop-jobs') return Response.json({ v: 1, items: [] });
    return Response.json(feedback);
  }));
});
afterEach(() => { cleanup(); clearMutationToken(); evictAll(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  [{ drop: { pending: [{ lane: 'codex-personal', file: `${job}.md` }] } }, 'waiting', 'waiting in drop · 3 min'],
  [{ workers: [{ job, lane: 'codex-personal', ageSeconds: 120 }] }, 'launched', 'launched on codex-personal · 2 min ago'],
])('restores %s progress after remount and disables queueing', async (reading, phase, text) => {
  runs = reading;
  rememberRecut(sessionStorage, '1234', { id, queuedAtMs: now - 180_000 });
  const view = mount();
  await waitFor(() => expect(within(row()).getByRole('status')).toHaveTextContent(text));
  expect(within(row()).getByRole('status')).toHaveAttribute('data-phase', phase);
  expect(within(row()).getByRole('button', { name: /^Queue recut/ })).toBeDisabled();
  view.unmount();
  mount();
  await waitFor(() => expect(within(row()).getByRole('status')).toHaveTextContent(text));
  expect(within(row()).getByRole('button', { name: /^Queue recut/ })).toBeDisabled();
});

it('persists a successful order and links its published PR after reopening', async () => {
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: /^Queue recut/ }));
  await waitFor(() => expect(within(row()).getByRole('status')).toHaveTextContent('queued · waiting for ingest'));
  expect(within(row()).getByRole('button', { name: /^Queue recut/ })).toBeDisabled();
  view.unmount();
  runs = { publishesLastHour: [{ job, url: 'https://github.com/ashlrai/phantom/pull/42' }] };
  evictAll();
  mount();
  const link = await screen.findByRole('link', { name: 'PR #42' });
  expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');
  expect(within(row()).getByRole('status')).toHaveAttribute('data-phase', 'published');
});

it('shows missing after ten minutes and permits another order', async () => {
  rememberRecut(sessionStorage, '1234', { id, queuedAtMs: now - 600_000 });
  mount();
  await waitFor(() => expect(within(row()).getByRole('status')).toHaveTextContent('not seen for 10 min (ingest may have rejected it)'));
  expect(within(row()).getByRole('button', { name: /^Queue recut/ })).toBeEnabled();
});
