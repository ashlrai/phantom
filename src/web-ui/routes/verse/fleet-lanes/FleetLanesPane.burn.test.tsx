import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture, withLane } from '../fleet/fleet-runs-fixtures.test-support.js';
import { isFleetRuns } from '../ops/ops-runs-model.js';
import { FleetLanesPane } from './FleetLanesPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const fact = (lane: string, label: string) => {
  const term = within(screen.getByText(lane, { selector: 'strong' }).closest('li')!).getByText(label, { selector: 'dt' });
  return term.nextElementSibling!;
};

it('shows live lane burn and the fleet total', async () => {
  const fixture = withLane(fleetRunsFixture({ claudeLane: null }), { lane: 'codex-personal', tokensLastHour: 1_300_000, merged24h: 9 });
  expect(isFleetRuns(fixture)).toBe(true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture, { status: 200 })));
  render(<FleetLanesPane visible />);
  expect(await screen.findByText('1.3M tokens in the last hour across 1 reporting lane')).toBeInTheDocument();
  expect(fact('codex-personal', 'Tokens last hour')).toHaveTextContent(/^1\.3M$/);
  expect(fact('codex-personal', 'Merged in 24 h')).toHaveTextContent(/^9$/);
  // A lane that reports no burn says so in words: never a dash that could pass for a small number, never zero.
  expect(fact('devin', 'Tokens last hour')).toHaveTextContent(/^unknown$/);
  expect(fact('devin', 'Tokens last hour')).toHaveAttribute('data-unknown');
  expect(fact('devin', 'Merged in 24 h')).toHaveTextContent(/^5$/);
});

it('heads the board with slots running, draws a mark per slot and names each lane state', async () => {
  const base = fleetRunsFixture({ claudeLane: null, lastTick: null, mergesLastHour: { count: null, items: [] } });
  const row = { queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null };
  const fixture = { ...base, lanes: [
    { ...row, lane: 'codex-personal', running: 2, target: 3, queued: 4 },
    { ...row, lane: 'devin', running: 2, target: 2 },
    { ...row, lane: 'claude', running: 1, target: 40, held: true, heldReason: 'usage_limit' },
    { ...row, lane: 'local', running: 0, target: 0 },
  ] };
  expect(isFleetRuns(fixture)).toBe(true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture, { status: 200 })));
  render(<FleetLanesPane visible />);
  expect(await screen.findByText('5 of 45 slots running, 1 lane held.')).toBeInTheDocument();
  expect(screen.getByText('Merges last hour unknown · last tick unknown')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Fleet slots: codex-personal 2 of 3, devin 2 of 2, claude 1 of 40' })).toBeInTheDocument();
  const card = (lane: string) => screen.getByText(lane, { selector: 'strong' }).closest('li')!;

  const open = screen.getByRole('img', { name: 'codex-personal: 2 running of 3 target' });
  expect([...open.children].map((pip) => pip.getAttribute('data-pip'))).toEqual(['running', 'running', 'open']);
  expect(card('codex-personal')).toHaveAttribute('data-state', 'open');
  expect(within(card('codex-personal')).getByText('1 open')).toBeInTheDocument();
  expect(within(card('codex-personal')).getByText('2/3 · 4 queued')).toBeInTheDocument();

  expect(card('devin')).toHaveAttribute('data-state', 'full');
  expect(within(card('devin')).getByText('Full')).toBeInTheDocument();

  // Too many slots to count by eye: one bar, and the Held badge states the lane instead of a state word.
  const large = screen.getByRole('img', { name: 'claude: 1 running of 40 target' });
  expect(large.querySelector('[data-pip]')).toBeNull();
  expect(large.firstElementChild).toHaveStyle({ width: '2.5%' });
  expect(card('claude')).toHaveAttribute('data-state', 'held');
  expect(within(card('claude')).getByText('Held')).toHaveAttribute('title', 'usage_limit');
  expect(within(card('claude')).queryByText(/open$/)).toBeNull();

  // A lane asked for nothing draws no slots at all rather than an empty bar.
  expect(within(card('local')).getByText('Target 0')).toBeInTheDocument();
  expect(within(card('local')).queryByRole('img', { name: /running of/ })).toBeNull();
});

it('names the pane, not a count, before the first reading and when the read fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'boom' }, { status: 500 })));
  render(<FleetLanesPane visible />);
  expect(await screen.findByText('Fleet runs are unavailable.')).toBeInTheDocument();
  expect(screen.getByText('Lanes')).toBeInTheDocument();
  expect(screen.queryByText(/slots running/)).toBeNull();
  expect(screen.queryByRole('img')).toBeNull();
});
