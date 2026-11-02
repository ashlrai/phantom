import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { JournalView } from './JournalView.js';
import { JournalEntryRow } from './JournalEntryRow.js';
import type { JournalEntry } from './journal-model.js';
import { evictAll } from '../../data/cache.js';

function renderJournal() {
  return render(
    <MemoryRouter>
      <JournalView />
    </MemoryRouter>,
  );
}

const now = new Date().toISOString();

const LOGS = { entries: [{ ts: now, kind: 'merge', msg: 'merged proposal p9' }], sourceQuality: { sourceState: 'healthy', complete: true } };
const ACTIVITY = {
  recentMerges: [],
  recentTicks: [],
  recentActions: [{ ts: now, actor: 'daemon', kind: 'merge', outcome: 'success', action: 'merge', summary: 'did the thing', proseDigest: 'Did the thing autonomously' }],
};
const RUNS = [
  { id: 'r1', goal: 'ship the feature', status: 'done', engine: 'e', provider: 'p', createdAt: now, updatedAt: now, budget: { maxTokens: 1, maxSteps: 1, allowCloud: true }, usage: { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0 }, tasks: [], steps: [] },
];
const INBOX = { pending: 0, proposals: [] };
const SNAPSHOT = { runs: [], swarms: [] };

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/logs-observation')) return new Response(JSON.stringify(LOGS), { status: 200 });
    if (url.startsWith('/api/fleet-activity')) return new Response(JSON.stringify(ACTIVITY), { status: 200 });
    if (url.startsWith('/api/run/')) {
      const id = url.slice('/api/run/'.length);
      const run = RUNS.find((r) => r.id === id);
      return run ? new Response(JSON.stringify(run), { status: 200 }) : new Response('not found', { status: 404 });
    }
    if (url.startsWith('/api/runs')) return new Response(JSON.stringify(RUNS), { status: 200 });
    if (url.startsWith('/api/inbox')) return new Response(JSON.stringify(INBOX), { status: 200 });
    if (url.startsWith('/api/snapshot')) return new Response(JSON.stringify(SNAPSHOT), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

describe('JournalView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges daemon log, fleet activity, and run history into one filterable feed', async () => {
    renderJournal();

    await waitFor(() => expect(screen.getByText('ship the feature')).toBeInTheDocument());
    expect(screen.getByText('Did the thing autonomously')).toBeInTheDocument();
    expect(screen.getByText('Daemon merge')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Actor: Unknown actor')).toHaveLength(3);
  });

  it.each([undefined, '', '   ', '\u202e\u0000'])('uses unknown attribution for an absent or empty actor (%j)', (actor) => {
    const entry = { id: 'synthetic', ts: now, source: 'agent-action', title: 'Synthetic action', detail: '', statusLabel: 'success', actor } satisfies JournalEntry & { actor?: string };
    render(<JournalEntryRow entry={entry} />);
    expect(screen.getByLabelText('Actor: Unknown actor')).toHaveTextContent('Unknown actor');
  });

  it('renders synthetic actor names as isolated text and removes directional controls', () => {
    const actor = '  Taylor <img src=x onerror=alert(1)>\u202e  ';
    const entry = { id: 'synthetic', ts: now, source: 'agent-action', title: 'Synthetic action', detail: '', statusLabel: 'success', actor } satisfies JournalEntry & { actor: string };
    const { container } = render(<JournalEntryRow entry={entry} />);
    const label = screen.getByLabelText('Actor: Taylor <img src=x onerror=alert(1)>');
    expect(label.tagName).toBe('BDI');
    expect(label).toHaveTextContent('Taylor <img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });

  it('bounds long synthetic actor names without splitting Unicode characters', () => {
    const actor = '🧑'.repeat(1000);
    const entry = { id: 'synthetic', ts: now, source: 'agent-action', title: 'Synthetic action', detail: '', statusLabel: 'success', actor } satisfies JournalEntry & { actor: string };
    render(<JournalEntryRow entry={entry} />);
    expect(screen.getByLabelText(`Actor: ${'🧑'.repeat(47)}…`)).toHaveTextContent(`${'🧑'.repeat(47)}…`);
    expect(screen.queryByText(actor)).not.toBeInTheDocument();
  });

  it('filters entries by source via the checkbox group', async () => {
    renderJournal();
    await waitFor(() => expect(screen.getByText('ship the feature')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Runs'));

    await waitFor(() => expect(screen.queryByText('ship the feature')).not.toBeInTheDocument());
    expect(screen.getByText('Did the thing autonomously')).toBeInTheDocument();
  });

  it('filters entries by search text', async () => {
    renderJournal();
    await waitFor(() => expect(screen.getByText('ship the feature')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Search the work journal'), { target: { value: 'nonexistent-xyz' } });

    await waitFor(() => expect(screen.getByText('Nothing matches the current filters in this window.')).toBeInTheDocument());
  });

  it('expanding a run row lazily loads its drill-in detail', async () => {
    renderJournal();
    await waitFor(() => expect(screen.getByText('ship the feature')).toBeInTheDocument());

    fireEvent.click(screen.getByText('ship the feature'));

    await waitFor(() => expect(screen.getByText(/Run finished/)).toBeInTheDocument());
  });
});
