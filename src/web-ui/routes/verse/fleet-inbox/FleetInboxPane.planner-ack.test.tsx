import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetInboxPane } from './FleetInboxPane.js';

vi.mock('../../../data/client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../data/client.js')>();
  return { ...actual, apiGet: vi.fn() };
});

const props: PaneProps = {
  paneId: 'fleet-inbox', sessionId: null, session: null, visible: true, presentation: 'column', roots: [], events: [], turnFiles: [],
  requests: { terminal: null, preview: null, diff: null },
  host: { addToMessage: vi.fn(), sendToChat: vi.fn(), openPane: vi.fn(), closePane: vi.fn(), openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn() },
};
const entries = [
  { at: '2026-10-31 00:13', source: 'desktop (one)', priority: 'P0', text: 'Seen order' },
  { at: '2026-10-31 00:16', source: 'telegram', priority: 'P0', text: 'Waiting order' },
];
let passAge = 300;
beforeEach(() => {
  evictAll(); sessionStorage.clear(); passAge = 300;
  vi.mocked(apiGet).mockImplementation(async path => path.includes('/inbox?')
    ? { v: 1, sourceState: 'healthy', entries }
    : { v: 1, generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: passAge }] });
});
afterEach(() => { cleanup(); clearMutationToken(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('uses the ledger label and keeps the inferred label when no ledger row exists', async () => {
  vi.mocked(apiGet).mockImplementation(async path => path.endsWith('/inbox/acks')
    ? { v: 1, available: true, acks: [{ entryId: 'one', status: 'acked' }] }
    : path.includes('/inbox?') ? { v: 1, sourceState: 'healthy', entries }
    : { v: 1, generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: 300 }] });
  render(<FleetInboxPane {...props} />);
  const acked = (await screen.findByText('Seen order')).closest('article')!;
  expect(await within(acked).findByText('Acked by planner')).toBeInTheDocument();
  expect(within(screen.getByText('Waiting order').closest('article')!).getByText(/^Waiting ·/)).toBeInTheDocument();
});
