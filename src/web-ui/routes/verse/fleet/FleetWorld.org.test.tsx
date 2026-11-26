import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { fleetOrgMap, type FleetOrgMap } from '../../../../core/fleet/org-map.js';
import { fleetOrgTree } from '../../../../core/fleet/org-tree.js';
import type { FleetRunsDirState } from '../../../../core/fleet/runs-dir-state.js';
import type { FleetSessionsV1 } from '../../../../core/fleet/runs-sessions.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import FleetWorld from './FleetWorld.js';

const read = vi.hoisted(() => ({ data: undefined as FleetOrgMap | undefined, status: 'loading' }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => read, useRefetch: () => () => {} }));
vi.mock('./JobDetailSheet.js', () => ({ JobDetailSheet: ({ job, repo, onClose }: { job: string; repo?: string | null; onClose: () => void }) =>
  <div role="dialog">{job} in {repo ?? 'unknown'}<button onClick={onClose}>Close</button></div> }));

const AT = '2026-11-18T12:00:00Z';
/** What GET /api/verse/fleet/control/map sends: the graph and its tree, built by the same functions as `phm org`. */
function served(sessions: object[], lanes: Array<{ lane: string }>): FleetOrgMap {
  const map = fleetOrgMap(null, { now: Date.parse(AT), observedLanes: lanes.map(row => row.lane), sessions: { generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions } as unknown as FleetSessionsV1 });
  return { ...map, tree: fleetOrgTree(map, { runs: { lanes, events: [], lastTick: AT, paused: false, sources: { status: 'healthy', events: 'healthy' } } as unknown as FleetRunsDirState }) };
}
const lane = (name: string, running: number, target: number, extra: object = {}) => ({ lane: name, running, target, queued: 0, held: false, heldReason: null, ...extra });

let viewport: ViewportMock | null = null;
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; read.data = undefined; read.status = 'loading'; });

describe.each([['desktop width', 1440], ['390 px', 390]])('Fleet world Org tab at %s', (_name, width) => {
  it('draws the org tree from the same map read and opens the same job detail', async () => {
    viewport = mockViewport(width);
    read.data = served([{ job: 'RQ-A', lane: 'claude', tier: 'frontier', repo: 'phantom', model: 'fixture-model', status: 'running', elapsedSeconds: 60, startedAt: AT, live: 'yes' }],
      [lane('claude', 1, 8), lane('devin', 0, 0, { held: true, heldReason: 'usage limit' })]);
    read.status = 'success';
    render(<FleetWorld read={undefined} initialLens="compute" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Org' }));
    const tree = await screen.findByRole('region', { name: 'Org tree' });
    expect(within(tree).getByText('Leader (CEO)')).toBeTruthy();
    expect(within(tree).getByRole('list', { name: 'Planners' })).toBeTruthy();
    const devin = within(tree).getByRole('button', { name: /^devin,/ });
    expect(devin.closest('li')).toHaveAttribute('data-state', 'held'); expect(devin).toHaveTextContent('Held: usage limit');
    fireEvent.click(within(tree).getByRole('button', { name: 'Open job RQ-A' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('RQ-A in phantom');
  });
});

it('Org tab on an empty fleet and before the first read', async () => {
  render(<FleetWorld read={undefined} initialLens="org" />);
  expect(await screen.findByText('Reading the organization…')).toBeTruthy();
  cleanup();
  read.data = served([], [lane('claude', 0, 8)]); read.status = 'success';
  render(<FleetWorld read={undefined} initialLens="org" />);
  const tree = await screen.findByRole('region', { name: 'Org tree' });
  expect(tree).toHaveTextContent('No jobs running');
  expect(within(tree).getByRole('button', { name: /^claude,/ })).toHaveTextContent('Idle, nothing queued');
  expect(within(tree).queryByRole('button', { name: /Open job/ })).toBeNull();
});
