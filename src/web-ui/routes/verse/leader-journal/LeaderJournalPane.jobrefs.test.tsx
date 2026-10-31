import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { LeaderJournalPane } from './LeaderJournalPane.js';
import styles from './leader-journal.module.css';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('opens job logs and links pull requests in notes, passes, and ingested jobs', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    v: 1, generatedAt: '2026-10-31T13:00:00Z',
    sources: { orchestration: 'healthy', planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' },
    notes: [{ at: '08:50 ET Oct 31', bullets: ['Claimed: RQ-PHX-EXAMPLE31 and #1999', 'A plain note.'] }],
    passes: [{ at: '2026-10-31T12:00:00Z', sections: [{ title: 'Plan', bullets: ['RQ-PHX-OTHER31 launched'] }] }],
    ingest: [], ingested: [{ at: '2026-10-31T12:03:00Z', id: 'RQ-PHX-INGEST31', lane: 'main', tier: 'mid', leader: 'alpha', title: 'Follow FIX-EXAMPLE31 in #2000' }],
    rejectedLastHour: null,
  })));
  render(<LeaderJournalPane visible />);
  const notes = await screen.findByRole('region', { name: 'Leader notes' });
  expect(within(notes).getByRole('button', { name: 'Open log for RQ-PHX-EXAMPLE31' })).toBeInTheDocument();
  expect(within(notes).getByRole('link', { name: '#1999' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1999');
  const plain = within(notes).getByText('A plain note.', { selector: 'li' });
  expect(plain.childNodes).toHaveLength(1);
  expect(plain.firstChild?.nodeType).toBe(Node.TEXT_NODE);

  const passes = screen.getByRole('region', { name: 'Passes' });
  expect(within(passes).getByRole('button', { name: 'Open log for RQ-PHX-OTHER31' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search journal' }), { target: { value: 'OTHER31' } });
  expect(within(passes).getByRole('button', { name: 'Open log for RQ-PHX-OTHER31' }).closest('li')).toHaveClass(styles.match);

  const table = screen.getByRole('table', { name: 'Ingested jobs' });
  expect(within(table).getByRole('button', { name: 'Open log for FIX-EXAMPLE31' })).toBeInTheDocument();
  expect(within(table).getByRole('link', { name: '#2000' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/2000');
  fireEvent.click(within(table).getByRole('button', { name: 'Open log for RQ-PHX-INGEST31' }));
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-INGEST31');
  expect(openDockPane).toHaveBeenCalledWith('worker-log');
});

it('does not open a log for an invalid ingested job id', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    v: 1, generatedAt: '2026-10-31T13:00:00Z',
    sources: { orchestration: 'healthy', planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' },
    notes: [], passes: [], ingest: [],
    ingested: [{ at: '2026-10-31T12:03:00Z', id: '../invalid', lane: 'main', tier: 'mid', leader: 'alpha', title: '' }],
    rejectedLastHour: null,
  })));
  render(<LeaderJournalPane visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open log for ../invalid' }));
  expect(requestWorkerLogJob).not.toHaveBeenCalled();
  expect(openDockPane).not.toHaveBeenCalled();
});
