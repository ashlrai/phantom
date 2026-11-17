import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrgMap } from './OrgMap.js';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { FleetOrgMap } from '../../../../core/fleet/org-map.js';

const read = vi.hoisted(() => ({ data: undefined as FleetOrgMap | undefined, status: 'loading' }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => read, useRefetch: () => () => {} }));
vi.mock('./JobDetailSheet.js', () => ({ JobDetailSheet: ({ job, onClose }: { job: string; onClose: () => void }) => <div role="dialog">{job}<button onClick={onClose}>Close</button></div> }));
afterEach(() => { cleanup(); read.data = undefined; read.status = 'loading'; });

function fixture(): FleetOrgMap {
  return { schema: 'fleet.map.v2', generatedAt: '2026-11-16T12:00:00Z', messageWindowMinutes: 15,
    sources: { fleet: 'available', sessions: 'healthy', messages: 'available' }, truncated: false, unmappedMessages: 0,
    nodes: [{ id: 'leader', kind: 'leader', label: 'Leader (CEO)', provider: 'unknown', status: 'unknown' },
      { id: 'lane:claude', kind: 'lane', label: 'claude', provider: 'Anthropic', status: 'running' },
      { id: 'job:J1', kind: 'job', label: 'Fix a bug', jobId: 'J1', provider: 'unknown', status: 'stale', repo: 'phantom', model: 'unknown', ageSeconds: 120 }],
    edges: [{ id: 'reports:J1', kind: 'reports-to', from: 'job:J1', to: 'lane:claude' },
      { id: 'message', kind: 'message', from: 'leader', to: 'lane:claude', count: 2 }] };
}

describe('Fleet map', () => {
  it('shows unknown when the fleet snapshot is unavailable', () => {
    render(<OrgMap live={null} />);
    expect(screen.getByText('Fleet state unknown.')).toBeTruthy();
  });
  it('shows jobs below their lane', () => {
    const live = { generatedAt: 'now', state: 'running', lanes: [{ lane: 'codex' }],
      runs: [{ id: 'J1', title: 'Fix a bug', repo: 'phantom', lane: 'codex', phase: 'producing', endedAt: null, outcome: null }] } as FleetLiveSnapshotV1;
    render(<OrgMap live={live} />);
    expect(within(screen.getByRole('region', { name: 'codex' })).getByRole('button', { name: 'Open job J1' })).toHaveTextContent('Fix a bug');
  });
  it('uses the shared graph for messages, stale jobs and one-click detail', () => {
    read.data = fixture(); read.status = 'success';
    render(<OrgMap live={null} />);
    expect(screen.getByRole('heading', { name: 'Messages in the last 15 minutes' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Agent messages' })).toHaveTextContent('Leader (CEO) → claude: 2 messages');
    const job = screen.getByRole('button', { name: 'Open job J1' });
    expect(job).toHaveTextContent('unknown'); expect(job).toHaveTextContent('stale · 2m old');
    fireEvent.click(job); expect(screen.getByRole('dialog')).toHaveTextContent('J1');
    fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('labels retained data after refresh failure and missing message evidence', () => {
    read.data = fixture(); read.data.sources.messages = 'unavailable'; read.status = 'error';
    render(<OrgMap live={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('may be stale');
    expect(screen.getByText('Agent messages unknown.')).toBeTruthy();
  });
});
