import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyState } from '../../../../core/drive/nodes/state.js';
import { readFleetCompute } from '../../../../core/fleet/compute-view.js';
import { getFleetSessions } from '../../../../core/fleet/runs-sessions.js';
import { readFleetSessionMap } from '../../../../core/fleet/sessions-view.js';
import { evictAll } from '../../../data/cache.js';
import { FleetMap } from '../../control/fleet/FleetMap.js';
import { ComputeMap } from './ComputeMap.js';
import { buildScene } from './scene3d-model.js';
import { lane } from './company.test-support.js';

const roots: string[] = [];
afterEach(async () => {
  cleanup(); evictAll(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** Run the production readers against disk receipts, then cross the JSON wire unchanged. */
async function serveProjection(published = false) {
  const now = Date.now(), at = new Date(now).toISOString();
  const root = await mkdtemp(join(tmpdir(), 'viz-surface-')); roots.push(root);
  const save = async (name: string, content: unknown) => {
    const path = join(root, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
    await utimes(path, new Date(now - 60_000), new Date(now - 60_000));
  };
  const state = emptyState(); state.sequence = 1; state.observedAt = now;
  state.nodes = ['mini', 'muse'].map(nodeId => ({ nodeId, session: 1, heartbeatAt: now,
    expiresAt: now + 60_000, owners: ['team'], slots: 4 }));
  state.jobs = ['RQ-LOCAL', 'RQ-REMOTE'].map((id, i) => ({ id, owner: 'team', state: 'running',
    claim: { nodeId: i ? 'muse' : 'mini', session: 1, token: 1, leaderToken: 1, jobId: id, expiresAt: now + 60_000 } }));
  await save('home/nodes/nodes.json', state);
  await save('home/node-pool/config.json', { node: 'mini' });
  await save('queue/status.json', { last_tick: at, lanes: { 'codex-personal': { hard_cap: 7, quota_ok: false } } });
  await save('queue/ready.tsv', 'RQ-WAIT\tphantom\tcodex-personal\twork\t/private/prompt\nRQ-HOLD\tphantom\tPARKED-DEP.codex-personal\twork\t/private/prompt\n');
  await save('queue/run/RQ-LOCAL.line', 'RQ-LOCAL\tphantom\tcodex-personal\twork\t/private/prompt\n');
  await save('RQ-LOCAL.base', 'abc123 work/contract /private/worktree\n');
  await save('RQ-LOCAL.log', 'Checking fleet integration\n');
  await save('RQ-LOCAL.publish', 'RESULT PR https://github.com/ashlrai/phantom/pull/42\n');
  // The live fixture retains a PR link from an older attempt, not a terminal
  // RESULT for this attempt. The published variant below keeps a fresh receipt.
  if (!published) await utimes(join(root, 'RQ-LOCAL.publish'), new Date(now - 120_000), new Date(now - 120_000));
  await save('metrics/jobs.jsonl', JSON.stringify({ job: 'RQ-LOCAL', event: 'launch', ts: new Date(now - 60_000).toISOString(), model: 'contract-model' }) + '\n');
  const compute = await readFleetCompute({ home: join(root, 'home'), runsDir: root, now, sample: () => ({
    sampledAtMs: now, uptimeSeconds: 500, load: [1, 2, 3], ramTotal: 16 * 1024 ** 3,
    ramUsed: 8 * 1024 ** 3, diskFree: null, cores: [{ total: 100, idle: 50 }],
  }) });
  const inventory = await getFleetSessions({ runsDir: root, now: () => now, runPs: async () => '' });
  const sessions = await readFleetSessionMap({ compute, sessions: inventory, runsDir: root, now });
  const payloads: Record<string, unknown> = {
    '/api/verse/fleet/control/compute': compute,
    '/api/verse/fleet/control/sessions': sessions,
    '/api/fleet/lanes': { schema: 'fleet.lanes.v1', generatedAt: at, lanes: [lane] },
  };
  const fetcher = vi.fn(async (url: RequestInfo | URL) => Response.json(payloads[String(url)] ?? {}, { status: payloads[String(url)] ? 200 : 503 }));
  vi.stubGlobal('fetch', fetcher);
  return { compute, sessions, now, fetcher };
}

it('renders real compute/session joins in Company 2D and 3D with the same identities and state', async () => {
  const { compute, sessions, now } = await serveProjection();
  expect(sessions.mapSessions.find(s => s.job === 'RQ-LOCAL')).toMatchObject({ nodeId: 'mini', placement: 'claim', mapState: 'running' });
  expect(sessions.mapSessions.find(s => s.job === 'RQ-WAIT')).toMatchObject({ nodeId: null, mapState: 'queued' });
  expect(sessions.mapSessions.find(s => s.job === 'RQ-HOLD')).toMatchObject({ nodeId: null, mapState: 'held' });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  render(<ComputeMap visible />);
  const local = (await screen.findByText('mini · this host')).closest('article')!;
  expect(await within(local).findByText('RQ-LOCAL')).toBeInTheDocument();
  expect(local).toHaveTextContent('contract-model');
  expect(local).toHaveTextContent('Checking fleet integration');
  expect(screen.getByText(/7 hard cap/)).toBeInTheDocument();
  const unassigned = within(screen.getByRole('region', { name: 'Unassigned agents' }));
  expect(unassigned.getByText('RQ-WAIT')).toBeInTheDocument();
  expect(unassigned.getByText('RQ-HOLD')).toBeInTheDocument();
  const scene = buildScene(compute.nodes, sessions.mapSessions, now, true);
  expect(scene.agents.map(a => a.job).sort()).toEqual(['RQ-LOCAL', 'RQ-REMOTE']);
  expect(scene.nodes.find(n => n.id === 'mini')?.heat).toBe(0.5);
  expect(scene.nodes.find(n => n.id === 'muse')?.heat).toBeNull();
  fireEvent.click(within(local).getByText('RQ-LOCAL'));
  const detail = screen.getByRole('region', { name: 'Agent detail' });
  expect(detail).toHaveTextContent('Branch: work/contract');
  expect(within(detail).getByRole('link', { name: 'Open recorded PR' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');
  fireEvent.click(screen.getByRole('button', { name: '3D' }));
  expect(screen.getByTestId('scene3d')).toHaveAccessibleName(/2 nodes, 2 agents shown/);
  expect(detail).toHaveTextContent('RQ-LOCAL');
});

it('renders the same disk-backed payloads on Control Fleet without mutations', async () => {
  const { fetcher } = await serveProjection();
  render(<MemoryRouter><FleetMap /></MemoryRouter>);
  const local = await screen.findByRole('region', { name: 'Machine mini' });
  expect(await within(local).findByRole('button', { name: 'Inspect session RQ-LOCAL' })).toHaveTextContent('contract-model');
  expect(within(screen.getByRole('region', { name: 'Machine muse' })).getByText('RQ-REMOTE')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Unplaced sessions' })).toHaveTextContent('RQ-HOLD');
  fireEvent.click(within(local).getByRole('button', { name: 'Inspect session RQ-LOCAL' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('work/contract');
  expect(screen.getByRole('link', { name: 'Open PR' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');
  expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual(['/api/verse/fleet/control/compute', '/api/verse/fleet/control/sessions']);
});


it('keeps a fresh publish receipt terminal despite a stale node claim, with recent detail intact', async () => {
  const { sessions } = await serveProjection(true);
  expect(sessions.mapSessions.filter(s => s.job === 'RQ-LOCAL')).toEqual([]);
  expect(sessions.mapRecent.filter(s => s.job === 'RQ-LOCAL')).toEqual([expect.objectContaining({
    status: 'finished', mapState: 'unknown', model: 'contract-model', branch: 'work/contract',
    prUrl: 'https://github.com/ashlrai/phantom/pull/42', activity: 'Checking fleet integration',
  })]);
  render(<MemoryRouter><FleetMap /></MemoryRouter>);
  const recent = await screen.findByText('Recently finished · 1');
  fireEvent.click(recent);
  const token = await screen.findByRole('button', { name: 'Inspect session RQ-LOCAL' });
  expect(token).toHaveTextContent('finished');
  expect(token).toHaveTextContent('contract-model');
  fireEvent.click(token);
  expect(screen.getByRole('dialog')).toHaveTextContent('work/contract');
  expect(screen.getByRole('link', { name: 'Open PR' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');
});
