import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleetOrgGroups, GUARDIAN_GROUP, LOOPS_GROUP, UNASSIGNED_GROUP } from '../src/core/fleet/org-groups.js';
import type { FleetLiveMap, LiveMapEdge, LiveMapNode } from '../src/core/fleet/live-map.js';
import { cmdFleetOrg, formatOrgGroupsText } from '../src/cli/fleet-org.js';
import { createFleetOrgGroupsApi } from '../src/core/verse/fleet-org-groups-api.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const node = (kind: LiveMapNode['kind'], id: string, status = 'running', label = id): LiveMapNode =>
  ({ id, kind, level: 0, label, provider: 'unknown', status, detail: 'x', live: null });
const reports = (from: string, to: string): LiveMapEdge =>
  ({ id: `reports-to:${from}->${to}`, kind: 'reports-to', from, to, messages: null, lastMessageAt: null, pulse: false });
const map = (nodes: LiveMapNode[], edges: LiveMapEdge[] = []) => ({ generatedAt: '2026-11-18T00:00:00Z', nodes, edges });
const get = (tree: ReturnType<typeof fleetOrgGroups>, id: string) => tree.nodes.find(row => row.id === id)!;

describe('fleetOrgGroups', () => {
  it('builds a three-level tree with counts from the leaves', () => {
    const tree = fleetOrgGroups(map(
      [node('leader', 'leader'), node('lane', 'lane:a', 'running'), node('job', 'job:1'), node('job', 'job:2', 'queued'), node('lane', 'lane:b', 'idle'), node('job', 'job:3', 'stale')],
      [reports('lane:a', 'leader'), reports('lane:b', 'leader'), reports('job:1', 'lane:a'), reports('job:2', 'lane:a'), reports('job:3', 'lane:b')]));
    expect(tree.root).toBe('leader');
    expect(tree.nodes.map(row => row.id)).toEqual(['leader', 'lane:a', 'job:1', 'job:2', 'lane:b', 'job:3']);
    expect(get(tree, 'leader').children).toEqual(['lane:a', 'lane:b']);
    expect(get(tree, 'job:1')).toMatchObject({ role: 'job', parent: 'lane:a', children: [] });
    expect(get(tree, 'lane:a').counts).toEqual({ running: 1, queued: 1, idle: 0, unknown: 0 });
    // A stale job is unknown, never idle.
    expect(get(tree, 'lane:b').counts).toEqual({ running: 0, queued: 0, idle: 0, unknown: 1 });
    expect(get(tree, 'leader').counts).toEqual({ running: 1, queued: 1, idle: 0, unknown: 1 });
    expect(tree.duplicates).toEqual([]);
  });

  it('puts a node with no known parent under "Other" instead of dropping it', () => {
    const tree = fleetOrgGroups(map(
      [node('leader', 'leader'), node('lane', 'lane:a'), node('job', 'job:orphan'), node('job', 'job:lost'), node('job', 'job:loop1'), node('job', 'job:loop2')],
      [reports('lane:a', 'leader'), reports('job:lost', 'lane:missing'), reports('job:loop1', 'job:loop2'), reports('job:loop2', 'job:loop1')]));
    expect(get(tree, UNASSIGNED_GROUP)).toMatchObject({ role: 'group', label: 'Other', parent: 'leader',
      children: ['job:orphan', 'job:lost', 'job:loop1', 'job:loop2'] });
    expect(get(tree, 'job:orphan').parent).toBe(UNASSIGNED_GROUP);
    expect(get(tree, UNASSIGNED_GROUP).counts.running).toBe(4);
  });

  it('places a leader, 2 lanes, 3 workers and 1 orphan, with the guardian and loops as their own branches', () => {
    const tree = fleetOrgGroups({ ...map(
      [node('leader', 'leader'), node('lane', 'lane:a'), node('lane', 'lane:b', 'idle'), node('job', 'job:1'), node('job', 'job:2'), node('job', 'job:3', 'queued'), node('job', 'job:orphan')],
      [reports('lane:a', 'leader'), reports('lane:b', 'leader'), reports('job:1', 'lane:a'), reports('job:2', 'lane:a'), reports('job:3', 'lane:b')]),
    planners: [{ id: 'executor', label: 'Executor', state: 'running', doing: 'Active' }, { id: 'guardian', label: 'Main guardian', state: 'idle', doing: 'Quiet' },
      { id: 'comms', label: 'Comms', state: 'unknown', doing: 'Unknown' }] });
    expect(tree.nodes.map(row => [row.id, row.parent])).toEqual([
      ['leader', null], ['lane:a', 'leader'], ['job:1', 'lane:a'], ['job:2', 'lane:a'], ['lane:b', 'leader'], ['job:3', 'lane:b'],
      [GUARDIAN_GROUP, 'leader'], ['planner:guardian', GUARDIAN_GROUP], [LOOPS_GROUP, 'leader'], ['planner:executor', LOOPS_GROUP], ['planner:comms', LOOPS_GROUP],
      [UNASSIGNED_GROUP, 'leader'], ['job:orphan', UNASSIGNED_GROUP]]);
    expect(get(tree, GUARDIAN_GROUP)).toMatchObject({ role: 'group', label: 'Guardian', counts: { idle: 1, running: 0 } });
    expect(get(tree, LOOPS_GROUP).counts).toEqual({ running: 1, queued: 0, idle: 0, unknown: 1 });
    expect(get(tree, 'planner:guardian')).toMatchObject({ role: 'planner', status: 'idle' });
    // The leader and the headline count jobs only.
    expect(get(tree, 'leader').counts).toEqual({ running: 3, queued: 1, idle: 0, unknown: 0 });
    expect(tree.headline.running).toBe(3);
    // Without planners from the server there are no extra branches.
    expect(fleetOrgGroups(map([node('leader', 'leader')])).nodes.map(row => row.id)).toEqual(['leader']);
  });

  it('keeps a parent with no children as its own leaf, and omits the group when nothing is unassigned', () => {
    const tree = fleetOrgGroups(map([node('leader', 'leader'), node('lane', 'lane:a', 'idle')], [reports('lane:a', 'leader')]));
    expect(get(tree, 'lane:a')).toMatchObject({ children: [], counts: { running: 0, queued: 0, idle: 1, unknown: 0 } });
    expect(tree.nodes.some(row => row.id === UNASSIGNED_GROUP)).toBe(false);
  });

  it('uses the first row of a duplicate id and lists it', () => {
    const tree = fleetOrgGroups(map(
      [node('leader', 'leader'), node('lane', 'lane:a', 'idle', 'first'), node('lane', 'lane:a', 'running', 'second')], [reports('lane:a', 'leader')]));
    expect(tree.nodes.filter(row => row.id === 'lane:a')).toHaveLength(1);
    expect(get(tree, 'lane:a')).toMatchObject({ label: 'first', counts: { idle: 1, running: 0 } });
    expect(tree.duplicates).toEqual(['lane:a']);
  });

  it('leaves computers and pools out, and an empty fleet is just the leader', () => {
    const tree = fleetOrgGroups(map([node('leader', 'leader'), node('computer', 'computer:a'), node('resource', 'resource:a')]));
    expect(tree.nodes.map(row => row.id)).toEqual(['leader']);
    const none = fleetOrgGroups(map([]));
    expect(none).toMatchObject({ root: 'leader', duplicates: [] });
    expect(none.nodes).toEqual([{ id: 'leader', role: 'leader', label: 'Leader', parent: null, children: [], counts: { running: 0, queued: 0, idle: 0, unknown: 0 } }]);
  });
});

describe('headline', () => {
  const fleet = (jobs: LiveMapNode[], lanes: Partial<LiveMapNode>[]) => fleetOrgGroups(map(
    [node('leader', 'leader'), ...lanes.map((extra, i) => ({ ...node('lane', `lane:${i}`, 'idle'), ...extra })), ...jobs, node('resource', 'resource:1', 'available')].map(row => row.id === 'resource:1' ? { ...row, usedPct: 70 } : row),
    [...lanes.map((_, i) => reports(`lane:${i}`, 'leader')), ...jobs.map(job => reports(job.id, 'lane:0'))])).headline;
  it('counts running and stuck jobs and sums merges per hour over lanes that reported', () => {
    expect(fleet([node('job', 'job:a'), { ...node('job', 'job:b'), live: false }, { ...node('job', 'job:c', 'queued'), live: false }], [{ mergedPerHour: 3 }, { mergedPerHour: 11.4 }, {}]))
      .toEqual({ running: 2, queued: 1, stuck: 1, mergedLastHour: 14, text: '2 running, 1 stuck, 14 merged in the last hour' });
  });
  it('says "Nothing running." when idle, and gives each lane its usage or null', () => {
    expect(fleet([], [{ mergedPerHour: 0 }]).text).toBe('Nothing running.');
    const tree = fleetOrgGroups(map([node('leader', 'leader'), node('lane', 'lane:1', 'idle'), node('lane', 'lane:2', 'idle'), { ...node('resource', 'resource:1', 'available'), usedPct: 70 }],
      [reports('lane:1', 'leader'), reports('lane:2', 'leader')]));
    expect([get(tree, 'lane:1').usedPct, get(tree, 'lane:2').usedPct]).toEqual([70, null]);
  });
});

describe('phm fleet org', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const tree = fleetOrgGroups(map([node('leader', 'leader', 'unknown', 'Leader'), node('lane', 'lane:a', 'running', 'alpha'), node('job', 'job:1')],
    [reports('lane:a', 'leader'), reports('job:1', 'lane:a')]));

  it('is registered under its own file and resolves by convention', async () => {
    expect(resolveFleetSubcommand('org')).toEqual({ module: './fleet-org.js', exportName: 'cmdFleetOrg' });
    expect(typeof (await FLEET_SUBCOMMAND_LOADERS['org']!()).cmdFleetOrg).toBe('function');
  });

  it('--json prints fleet.org-groups.v1 with the documented keys', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetOrg(['--json'], async () => tree)).toBe(0);
    const body = JSON.parse(String(out.mock.calls[0]![0]));
    expect(Object.keys(body)).toEqual(['schema', 'generatedAt', 'root', 'nodes', 'duplicates', 'headline']);
    expect(body.schema).toBe('fleet.org-groups.v1');
    expect(Object.keys(body.nodes[1])).toEqual(['id', 'role', 'label', 'parent', 'children', 'counts', 'status', 'mergedPerHour', 'usedPct']);
    expect(Object.keys(body.headline)).toEqual(['running', 'queued', 'stuck', 'mergedLastHour', 'text']);
    expect(body.headline).toEqual({ running: 1, queued: 0, stuck: 0, mergedLastHour: null, text: '1 running, 0 stuck, merged unknown' });
    expect(body.nodes[1].usedPct).toBeNull();
    expect(Object.keys(body.nodes[1].counts)).toEqual(['running', 'queued', 'idle', 'unknown']);
  });

  it('prints plain indented text, and rejects other arguments with exit 2', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetOrg([], async () => tree)).toBe(0);
    expect(String(out.mock.calls[0]![0])).toBe(formatOrgGroupsText(tree));
    expect(String(out.mock.calls[0]![0]).split('\n')[0]).toBe('1 running, 0 stuck, merged unknown');
    expect(String(out.mock.calls[0]![0]).split('\n')[2]).toBe('  alpha (lane): 1 running, 0 queued, 0 idle, 0 unknown');
    expect(await cmdFleetOrg(['--nope'], async () => tree)).toBe(2);
    expect(err).toHaveBeenCalled();
    expect(await cmdFleetOrg(['--help'], async () => tree)).toBe(0);
  });
});

describe('GET /api/verse/fleet/control/org-groups', () => {
  const live = { schema: 'fleet.live-map.v1', generatedAt: 'now', nodes: [node('leader', 'leader')], edges: [] } as unknown as FleetLiveMap;
  const call = async (method: string, url: string, readSession: unknown) => {
    const sent: { status: number; body: unknown }[] = [];
    const res = { writeHead: (status: number) => { sent.push({ status, body: null }); }, end: (body: string) => { sent[0]!.body = JSON.parse(body); }, setHeader: () => {} };
    const handled = await createFleetOrgGroupsApi(async () => live)({ readSession } as never, { url } as never, res as never, url.split('?')[0]!, method);
    return { handled, sent: sent[0] };
  };
  const session = { expiresAt: Date.now() + 60_000 };
  it('serves the tree to a current read session only, read-only and without a query', async () => {
    const ok = await call('GET', '/api/verse/fleet/control/org-groups', session);
    expect(ok.sent?.status).toBe(200);
    expect(ok.sent?.body).toMatchObject({ schema: 'fleet.org-groups.v1', root: 'leader' });
    expect((await call('GET', '/api/verse/fleet/control/org-groups', null)).sent?.status).toBe(401);
    expect((await call('POST', '/api/verse/fleet/control/org-groups', session)).sent?.status).toBe(405);
    expect((await call('GET', '/api/verse/fleet/control/org-groups?x=1', session)).sent?.status).toBe(400);
    expect((await call('GET', '/api/verse/fleet/control/other', session)).handled).toBe(false);
  });
});
