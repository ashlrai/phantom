import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QueryEntry } from '../../../data/cache.js';
import { useQuery } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { getPane } from '../panes/pane-registry.js';
import './intent.pane.js';
import { IntentPane, intentQuery } from './IntentPane.js';
import { intentPanelModel } from './intent-model.js';

const state = vi.hoisted(() => ({ queries: new Map<string, QueryEntry<unknown>>(), refresh: vi.fn() }));
vi.mock('../../../data/hooks.js', () => ({
  useQuery: vi.fn((def: { key: string }, options?: { enabled: boolean }) => options?.enabled === false
    ? { data: undefined, error: undefined, status: 'idle', updatedAt: null } : state.queries.get(def.key)),
  useRefetch: () => state.refresh,
}));

const props: PaneProps = {
  paneId: 'intent', sessionId: null, session: null, visible: true, presentation: 'column', roots: [], events: [], turnFiles: [],
  requests: { terminal: null, preview: null, diff: null },
  host: { addToMessage: vi.fn(), sendToChat: vi.fn(), openPane: vi.fn(), closePane: vi.fn(), openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn() },
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

it('registers the Intent pane without a chat', () => {
  expect(getPane('intent')).toMatchObject({ title: 'Intent', needsSession: false });
});

it('shows totals and a stale row', () => {
  state.queries.set(intentQuery.key, {
    data: {
      present: true, items: 2, tracked: 1, merged: 1, shipped: 0, verified: 0, stale: 1,
      staleItems: [{ id: 'int-1' }],
      records: [
        { id: 'int-1', title: 'Keep the ledger fresh…', status: 'queued', rq: ['RQ-INTENT-LEDGER-1'], partial: true, prs: [] },
        { id: 'int-2', title: 'World model', status: 'merged', rq: ['RQ-WORLD-1'], partial: false, prs: [{ repo: 'ashlrai/phantom', number: 4210 }] },
      ],
    },
    error: undefined, status: 'success', updatedAt: null,
  });
  render(<IntentPane {...props} />);
  expect(screen.getByRole('region', { name: 'Intents' })).toHaveTextContent('2 items · 1 tracked · 1 merged · 0 shipped · 0 verified · 1 stale');
  expect(screen.getByText('Keep the ledger fresh… (partial)')).toBeInTheDocument();
  expect(screen.getByText(/RQ-INTENT-LEDGER-1/)).toHaveTextContent('stale');
  expect(screen.getByText(/ashlrai\/phantom#4210/)).toBeInTheDocument();
  expect(useQuery).toHaveBeenCalled();
});

it('says the ledger is unknown when the file is missing', () => {
  expect(intentPanelModel({ present: false }).ready).toBe(false);
  state.queries.set(intentQuery.key, { data: { present: false }, error: undefined, status: 'success', updatedAt: null });
  render(<IntentPane {...props} />);
  expect(screen.getByText(/Intent ledger is unknown/)).toBeInTheDocument();
});
