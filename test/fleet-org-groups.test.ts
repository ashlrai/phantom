import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleetOrgGroups, UNASSIGNED_GROUP } from '../src/core/fleet/org-groups.js';
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

  it('puts a node with no known parent under "unassigned" instead of dropping it', () => {
    const tree = fleetOrgGroups(map(
      [node('leader', 'leader'), node('lane', 'lane:a'), node('job', 'job:orphan'), node('job', 'job:lost'), node('job', 'job:loop1'), node('job', 'job:loop2')],
      [reports('lane:a', 'leader'), reports('job:lost', 'lane:missing'), reports('job:loop1', 'job:loop2'), reports('job:loop2', 'job:loop1')]));
    expect(get(tree, UNASSIGNED_GROUP)).toMatchObject({ role: 'group', label: 'unassigned', parent: 'leader',
      children: ['job:orphan', 'job:lost', 'job:loop1', 'job:loop2'] });
    expect(get(tree, 'job:orphan').parent).toBe(UNASSIGNED_GROUP);
    expect(get(tree, UNASSIGNED_GROUP).counts.running).toBe(4);
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
    expect(Object.keys(body)).toEqual(['schema', 'generatedAt', 'root', 'nodes', 'duplicates']);
    expect(body.schema).toBe('fleet.org-groups.v1');
    expect(Object.keys(body.nodes[1])).toEqual(['id', 'role', 'label', 'parent', 'children', 'counts']);
    expect(Object.keys(body.nodes[1].counts)).toEqual(['running', 'queued', 'idle', 'unknown']);
  });

  it('prints plain indented text, and rejects other arguments with exit 2', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetOrg([], async () => tree)).toBe(0);
    expect(String(out.mock.calls[0]![0])).toBe(formatOrgGroupsText(tree));
    expect(String(out.mock.calls[0]![0]).split('\n')[1]).toBe('  alpha (lane): 1 running, 0 queued, 0 idle, 0 unknown');
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
