import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetOutcomesPane } from './FleetOutcomesPane.js';

vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

beforeEach(() => {
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    v: 1, state: 'current', feedback: { sourceState: 'healthy', cases: [
      { caseId: 'RQ-PHX-EXAMPLE31', outcome: 'failed', proposalRecorded: true, prNumber: 1234 },
      { caseId: 'h:0000000000000001:0000000000000002:0000000000000003:0000000000000004', outcome: 'failed', proposalRecorded: false },
    ] },
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('opens the selected worker log and links its PR without selecting the timeline', async () => {
  const openPane = vi.fn();
  const props = { visible: true, host: { openPane } } as PaneProps;
  render(<FleetOutcomesPane {...props} />);
  const rows = within(await screen.findByRole('list', { name: 'Cases' })).getAllByRole('listitem');
  const link = within(rows[0]!).getByRole('link', { name: '#1234' });
  expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1234');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noreferrer');
  fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Open worker log' }));
  expect(requestWorkerLogJob).toHaveBeenCalledExactlyOnceWith('RQ-PHX-EXAMPLE31');
  expect(openPane).toHaveBeenCalledExactlyOnceWith('worker-log');
  expect(vi.mocked(requestWorkerLogJob).mock.invocationCallOrder[0]).toBeLessThan(openPane.mock.invocationCallOrder[0]!);
  expect(screen.queryByRole('region', { name: 'Case timeline' })).not.toBeInTheDocument();
  expect(within(rows[1]!).queryByRole('button', { name: 'Open worker log' })).not.toBeInTheDocument();
  expect(rows[1]).toHaveTextContent('no PR');
});
