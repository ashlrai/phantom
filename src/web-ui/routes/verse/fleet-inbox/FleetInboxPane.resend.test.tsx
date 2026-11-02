import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetInboxPane } from './FleetInboxPane.js';

vi.mock('../../../data/client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../data/client.js')>();
  return { ...actual, apiGet: vi.fn() };
});
vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

const props: PaneProps = {
  paneId: 'fleet-inbox', sessionId: null, session: null, visible: true, presentation: 'column', roots: [], events: [], turnFiles: [],
  requests: { terminal: null, preview: null, diff: null },
  host: { addToMessage: vi.fn(), sendToChat: vi.fn(), openPane: vi.fn(), closePane: vi.fn(), openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn() },
};

beforeEach(() => {
  evictAll(); sessionStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T04:40:00Z'));
  vi.mocked(apiGet).mockImplementation(async path => path.includes('/inbox?')
    ? { v: 1, sourceState: 'healthy', entries: [
      { at: '2026-10-31 00:13', source: 'desktop', priority: 'P0', text: 'Seen order' },
      { at: '2026-10-31 00:16', source: 'telegram', priority: 'P0', text: 'Waiting order' },
    ] }
    : { v: 1, generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: 300 }] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('opens a repeat prefill for an overdue waiting order but offers no resend for a seen order', async () => {
  render(<FleetInboxPane {...props} />);
  const waiting = (await screen.findByText('Waiting order')).closest('article')!;
  const seen = screen.getByText('Seen order').closest('article')!;
  expect(within(waiting).getByText('Waiting · pass overdue by 10 min')).toHaveAttribute('data-overdue', 'true');
  expect(within(seen).getByText('Seen by a leader pass')).toBeInTheDocument();
  expect(within(seen).queryByRole('button', { name: /Resend/ })).not.toBeInTheDocument();

  fireEvent.click(within(waiting).getByRole('button', { name: 'Resend order from 00:16' }));
  expect(openInterjectDialog).toHaveBeenCalledOnce();
  const { prefill } = vi.mocked(openInterjectDialog).mock.calls[0]![0]!;
  expect(prefill).toMatch(/^Repeat of my/);
  expect(prefill).toContain('Waiting order');
});
