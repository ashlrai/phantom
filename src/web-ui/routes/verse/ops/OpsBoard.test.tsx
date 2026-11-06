/**
 * Component test: the board renders fixture bus data into the five handoff
 * columns, carries assignee / estimate / outcome, and says when a source is
 * degraded rather than showing a partial board as whole.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { OpsBoard } from './OpsBoard.js';
import type { OpsBoardV1, OpsTaskRow } from '../../../../core/verse/ops-types.js';

function task(over: Partial<OpsTaskRow> = {}): OpsTaskRow {
  return {
    id: 'fleet:t1', source: 'fleet', title: 'Fix the gate', repo: 'ashlrai/phantom',
    column: 'active', assignee: 'seat-claude-1', estimate: 'medium · ≤3 files / 200 lines',
    outcome: null, needsYou: false, updatedAt: '2026-10-30T10:00:00Z', ...over,
  };
}

function fixture(rows: OpsTaskRow[] = [], degraded: OpsBoardV1['sources'] = { fleet: 'healthy', handoff: 'healthy', companion: 'healthy' }): OpsBoardV1 {
  const columns = { next: [], active: [], held: [], done: [], closed: [] } as OpsBoardV1['columns'];
  const counts = { next: 0, active: 0, held: 0, done: 0, closed: 0 } as OpsBoardV1['counts'];
  for (const row of rows) { columns[row.column].push(row); counts[row.column] += 1; }
  return { v: 1, generatedAt: '2026-10-30T10:05:00Z', team: 'default', columns, counts, sources: degraded };
}

function stub(value: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(value)));
}

beforeEach(() => { evictAll(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('OpsBoard', () => {
  it('renders fixture tasks into their columns with assignee, estimate and outcome', async () => {
    stub(fixture([
      task(),
      task({ id: 'handoff:h1', source: 'handoff', title: 'Review the release notes', column: 'held', assignee: 'human:mason', estimate: null, needsYou: true, updatedAt: '2026-10-30T09:00:00Z' }),
      task({ id: 'handoff:h2', source: 'handoff', title: 'Ship the wiki', column: 'done', assignee: 'agent:codex/mason', estimate: null, outcome: { state: 'completed', text: 'Merged as #512' }, updatedAt: '2026-10-29T10:00:00Z' }),
      task({ id: 'companion:c1', source: 'companion', title: 'Run nightly checks', column: 'next', assignee: 'devin/acct-1/agent-9', estimate: 'cap $2.00 · due 2026-10-31', updatedAt: '2026-10-28T10:00:00Z' }),
    ]));
    render(<OpsBoard />);
    await screen.findByText('Fix the gate');
    expect(screen.getByText('Assignee: seat-claude-1')).toBeInTheDocument();
    expect(screen.getByText('Estimate: medium · ≤3 files / 200 lines')).toBeInTheDocument();
    expect(screen.getByText('Review the release notes')).toBeInTheDocument();
    expect(screen.getByText('completed: Merged as #512')).toBeInTheDocument();
    expect(screen.getByText('Run nightly checks')).toBeInTheDocument();
    expect(screen.getByText('cap $2.00 · due 2026-10-31', { exact: false })).toBeInTheDocument();
    // Column headers carry counts.
    expect(screen.getByRole('heading', { name: /In flight/ })).toHaveTextContent('1');
    expect(screen.getByRole('heading', { name: /Done/ })).toHaveTextContent('1');
    expect(screen.getByRole('heading', { name: /Held/ })).toHaveTextContent('1');
    expect(screen.getByRole('heading', { name: /Next up/ })).toHaveTextContent('1');
  });

  it('names degraded sources instead of showing a partial board as whole', async () => {
    stub(fixture([task()], { fleet: 'healthy', handoff: 'degraded', companion: 'healthy' }));
    render(<OpsBoard />);
    await screen.findByText('Fix the gate');
    expect(screen.getByRole('status')).toHaveTextContent('Handoff could not be read');
  });

  it('shows the unavailable state when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'nope' }, { status: 500 })));
    render(<OpsBoard />);
    await screen.findByText('The board is unavailable. Refresh to reconnect.');
  });
});
