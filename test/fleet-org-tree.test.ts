import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fleetOrgMap, type FleetOrgMap } from '../src/core/fleet/org-map.js';
import { fleetOrgTree, orgLive, renderOrgTreeText, type FleetOrgTree } from '../src/core/fleet/org-tree.js';
import { readFleetRunsDirState, type FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import type { ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';
import type { FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';

const mocks = vi.hoisted(() => ({ read: vi.fn(), groups: vi.fn() }));
vi.mock('../src/core/verse/fleet-org-map-api.js', () => ({ readFleetOrgMap: mocks.read }));
vi.mock('../src/core/verse/fleet-org-groups-api.js', () => ({ readFleetOrgGroups: mocks.groups }));
import { cmdOrg } from '../src/cli/org.js';

const NOW = Date.parse('2026-11-17T12:00:00Z'), AT = '2026-11-17T12:00:00Z';
const session = (job: string, lane: string, extra: object = {}) => ({ job, lane, repo: 'phantom', model: 'claude-fable-5-2', status: 'running',
  elapsedSeconds: 600, startedAt: '2026-11-17T11:50:00Z', live: 'yes', ...extra });
function map(sessions: object[], messages?: Parameters<typeof fleetOrgMap>[1]['messages']): FleetOrgMap {
  return fleetOrgMap(null, { now: NOW, messages,
    sessions: { generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions } as unknown as FleetSessionsV1 });
}
const lane = (name: string, running: number, target: number, queued: number) => ({ lane: name, running, target, queued, held: false,
  floor: null, ceiling: null, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const runs = (lanes: FleetRunsDirState['lanes'], events: FleetRunsDirState['events'] = []) => ({ lanes, events, lastTick: AT, paused: false,
  sources: { status: 'healthy' } }) as unknown as FleetRunsDirState;
const usage = (lanes: object[]) => ({ asOf: '2026-11-17T11:00:00Z', lanes, sources: { status: 'healthy' } }) as unknown as ResourceLedgerV1;
const find = (tree: FleetOrgTree, name: string) => tree.lanes.find(row => row.lane === name)!;

describe('fleetOrgTree', () => {
  it('puts running jobs under their lane with counts, usage, start and last event', () => {
    const tree = fleetOrgTree(map([session('RQ-A', 'claude'), session('RQ-AB', 'claude', { model: null, repo: null, startedAt: null, live: 'unknown' })]), {
      runs: runs([lane('claude', 2, 8, 3)], [{ at: '2026-11-17T11:58:00Z', kind: 'PUBLISH_START', text: 'RQ-A phantom' }, { at: '2026-11-17T11:50:00Z', kind: 'LAUNCH', text: 'RQ-A phantom claude frontier' }]),
      usage: usage([{ lane: 'claude', usedPct: 41.6, resetAt: null, observation: { source: 'claude-native-usage', asOf: '2026-11-17T11:59:00Z' } }]),
    });
    expect(tree.schema).toBe('fleet.org.v1');
    expect(tree.version).toBe(1);
    expect(tree.leader).toEqual({ label: 'Leader (CEO)', status: 'unknown', provider: 'unknown', model: null, state: 'running',
      doing: 'Directing 2 running jobs across 1 lane', dispatcher: { lastTick: AT, paused: false } });
    // One job names no model, so the lane does not claim one.
    expect(find(tree, 'claude')).toMatchObject({ provider: 'Anthropic', model: null, state: 'running', doing: '2 jobs running', heldReason: null, running: 2, target: 8, queued: 3, held: false,
      usage: { usedPct: 41.6, asOf: '2026-11-17T11:59:00Z', resetAt: null } });
    expect(find(tree, 'claude').jobs).toEqual([
      { id: 'RQ-A', repo: 'phantom', model: 'claude-fable-5-2', provider: 'Anthropic', status: 'running', tier: null, ageSeconds: 600, goal: null, state: 'running', doing: 'Working in phantom',
        startedAt: '2026-11-17T11:50:00Z', prUrl: null, lastEvent: { at: '2026-11-17T11:58:00Z', kind: 'PUBLISH_START' }, lastActivityAt: AT },
      // RQ-A's events never attach to RQ-AB, and its missing facts stay null.
      { id: 'RQ-AB', repo: null, model: null, provider: 'Anthropic', status: 'running', tier: null, ageSeconds: 600, goal: null, state: 'running', doing: 'Working', startedAt: null, prUrl: null, lastEvent: null, lastActivityAt: null },
    ]);
    expect(orgLive(AT, NOW)).toBe(true); expect(orgLive('2026-11-17T11:54:59Z', NOW)).toBe(false); expect(orgLive(null, NOW)).toBeNull();
    const text = renderOrgTreeText(tree, NOW);
    expect(text).toContain('claude (Anthropic, model unknown): running. 2 running of 8, 3 queued, usage 42% (measured 1m ago)');
    expect(text).toContain('* RQ-A | running | Working in phantom | claude-fable-5-2 | started 10m ago | last event PUBLISH_START 2m ago | tier unknown | goal unknown');
    expect(text).toContain('- RQ-AB | running | Working | model unknown | started unknown | last event unknown | tier unknown | goal unknown');
  });

  it('says idle for an empty lane, and unknown when no job source answered', () => {
    const tree = fleetOrgTree(map([]), { runs: runs([lane('gemini', 0, 1, 0)]) });
    expect(find(tree, 'gemini')).toMatchObject({ running: 0, target: 1, queued: 0, jobs: [] });
    expect(tree.jobsKnown).toBe(true);
    expect(renderOrgTreeText(tree, NOW)).toMatch(/gemini \(Google, model unknown\): idle\. Idle, nothing queued\. 0 running of 1, 0 queued, usage unknown\n {4}idle/);
    const dark = fleetOrgTree(fleetOrgMap(null));
    expect(dark.jobsKnown).toBe(false); expect(dark.messages).toBeNull();
    expect(renderOrgTreeText(dark, NOW)).toContain('jobs unknown'); expect(renderOrgTreeText(dark, NOW)).not.toMatch(/\bidle\b/);
  });

  it('keeps missing usage and missing counts unknown, never zero', () => {
    const tree = fleetOrgTree(map([session('RQ-A', 'devin')]), { runs: runs([]), usage: usage([{ lane: 'devin', usedPct: null, resetAt: null }]) });
    expect(find(tree, 'devin')).toMatchObject({ running: null, target: null, queued: null, held: null, usage: { usedPct: null, asOf: '2026-11-17T11:00:00Z' } });
    expect(find(tree, 'grok').usage).toEqual({ usedPct: null, asOf: null, resetAt: null });
    const text = renderOrgTreeText(tree, NOW);
    expect(text).toContain('devin (Cognition, claude-fable-5-2): running. unknown running of unknown, unknown queued, usage unknown');
    expect(text).not.toMatch(/\b0 running|usage 0%/);
    expect(JSON.stringify(tree.lanes.map(row => [row.running, row.target, row.queued, row.usage.usedPct]))).not.toContain('0');
  });

  it('drops a malformed status line and event line without inventing counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'org-tree-')); mkdirSync(join(dir, 'queue'));
    writeFileSync(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: AT, paused: false, mem_free_pct: 50, lanes: {
      claude: { running: 1, target: 8, queued: 2, held: false }, devin: { running: 'seventeen', target: 0, held: 'yes' } } }));
    writeFileSync(join(dir, 'dispatch-events.log'), 'not an event line\n2026-11-17 11:59:00 LAUNCH RQ-A phantom claude frontier\n');
    const state = await readFleetRunsDirState({ runsDir: dir, now: () => NOW });
    const tree = fleetOrgTree(map([session('RQ-A', 'claude', { live: 'no' }), session('RQ-D', 'devin')]), { runs: state });
    expect(tree.sources.lanes).toBe('degraded');
    expect(find(tree, 'claude')).toMatchObject({ running: 1, target: 8, queued: 2 });
    expect(find(tree, 'claude').jobs[0]).toMatchObject({ lastEvent: { at: '2026-11-17T11:59:00Z', kind: 'LAUNCH' }, lastActivityAt: '2026-11-17T11:59:00Z' });
    expect(find(tree, 'devin')).toMatchObject({ running: null, target: null, queued: null, held: null });
    expect(find(tree, 'devin').jobs.map(job => job.id)).toEqual(['RQ-D']);
  });

  it('keeps JSON order stable whatever order the sources report in', () => {
    const edges = [{ from: { address: 'leader', provider: null }, to: { address: 'devin', provider: null }, messages: 1, messagesLastHour: 1, lastAt: 2 },
      { from: { address: 'leader', provider: null }, to: { address: 'claude', provider: null }, messages: 3, messagesLastHour: 3, lastAt: 1 }];
    const rows = [session('RQ-B', 'zz-custom'), session('RQ-C', 'claude', { startedAt: '2026-11-17T11:40:00Z' }), session('RQ-A', 'claude'), session('RQ-D', 'aa-custom')];
    const laneRows = [lane('zz-custom', 1, 1, 0), lane('claude', 2, 8, 0), lane('aa-custom', 1, 1, 0)];
    const build = (flip: boolean) => JSON.stringify(fleetOrgTree(
      map(flip ? [...rows].reverse() : rows, { schema: 'fleet.edges.v1', source: 'available', edges: flip ? [...edges].reverse() : edges }),
      { runs: runs(flip ? [...laneRows].reverse() : laneRows) }));
    expect(build(true)).toBe(build(false));
    const tree = JSON.parse(build(false)) as FleetOrgTree;
    expect(Object.keys(tree)).toEqual(['schema', 'version', 'generatedAt', 'leader', 'planners', 'lanes', 'jobsKnown', 'messages', 'messageWindowMinutes', 'unmappedMessages', 'sources']);
    expect(tree.lanes.map(row => row.lane)).toEqual(['codex-personal', 'claude', 'claude-api', 'devin', 'devin-flash', 'codex-local', 'zai', 'gemini', 'grok', 'cursor', 'aa-custom', 'zz-custom']);
    expect(find(tree, 'claude').jobs.map(job => job.id)).toEqual(['RQ-C', 'RQ-A']);
    expect(tree.messages).toEqual([{ from: 'Leader (CEO)', to: 'claude', count: 3, lastAt: '1970-01-01T00:00:00.001Z' }, { from: 'Leader (CEO)', to: 'devin', count: 1, lastAt: '1970-01-01T00:00:00.002Z' }]);
  });
});

describe('fleetOrgTree health and message times', () => {
  it('carries each lane health badge, null for a lane with no reading, and the last message time', () => {
    const edges = { source: 'available', edges: [{ from: { address: 'leader', provider: null }, to: { address: 'claude', provider: null }, messages: 2, messagesLastHour: 2, lastAt: Date.parse('2026-11-17T11:55:00Z') }] } as unknown as Parameters<typeof fleetOrgMap>[1]['messages'];
    const tree = fleetOrgTree(map([session('RQ-A', 'claude')], edges), { runs: runs([lane('claude', 1, 8, 0)]),
      laneHealth: [{ lane: 'claude', health: { state: 'starved', reason: 'starved: 5 free slots', number: 5 } }, { lane: 'devin' }] });
    expect(find(tree, 'claude').health).toEqual({ state: 'starved', reason: 'starved: 5 free slots', number: 5 });
    expect(find(tree, 'devin').health).toBeNull();
    expect(find(tree, 'zai').health).toBeNull();
    expect(fleetOrgTree(map([]), {}).lanes.every(row => row.health === null)).toBe(true);
    expect(tree.messages).toEqual([{ from: 'Leader (CEO)', to: 'claude', count: 2, lastAt: '2026-11-17T11:55:00.000Z' }]);
  });
});

describe('phm org', () => {
  it('prints the tree as JSON by default and as text with --text, and rejects stray input', async () => {
    const tree = fleetOrgTree(map([session('RQ-A', 'claude')]), { runs: runs([lane('claude', 1, 8, 0)]) });
    mocks.read.mockResolvedValue({ tree });
    const groups = { schema: 'fleet.org-groups.v1', root: 'leader', nodes: [{ id: 'leader' }] };
    mocks.groups.mockResolvedValue(groups);
    const out: string[] = [], log = vi.spyOn(console, 'log').mockImplementation(line => { out.push(String(line)); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdOrg([])).toBe(0);
      expect(JSON.parse(out.pop()!)).toEqual({ ...JSON.parse(JSON.stringify(tree)), groups });
      // An unreadable live map is null, and the rest of the tree still prints.
      mocks.groups.mockRejectedValueOnce(new Error('fixture failure'));
      expect(await cmdOrg(['--json'])).toBe(0);
      expect(JSON.parse(out.pop()!)).toEqual({ ...JSON.parse(JSON.stringify(tree)), groups: null });
      expect(mocks.read).toHaveBeenLastCalledWith(60);
      expect(await cmdOrg(['--text', '--minutes', '15'])).toBe(0);
      expect(out.pop()).toContain('claude (Anthropic, claude-fable-5-2): running. 1 running of 8, 0 queued, usage unknown');
      expect(mocks.read).toHaveBeenLastCalledWith(15);
      mocks.read.mockClear();
      for (const args of [['--apply'], ['--minutes'], ['--file', 'org.toml']]) expect(await cmdOrg(args)).toBe(2);
      // A window outside 1..1440 or not a whole number is usage (exit 2) with
      // the org.error.v1 envelope — the same refusal --window and --minutes
      // give on the fleet verbs — never the operational 'error' exit 1.
      for (const bad of ['0', '1441', 'abc', '-5', '1.5', '999999999999999999999']) {
        expect(await cmdOrg(['--minutes', bad, '--json'])).toBe(2);
        expect(JSON.parse(out.at(-1)!)).toMatchObject({ schema: 'org.error.v1', command: 'org',
          error: { code: 'usage', message: expect.stringContaining('--minutes must be a whole number from 1 to 1440') } });
      }
      // A flag where the value belongs is a missing value, also usage.
      expect(await cmdOrg(['--minutes', '--json'])).toBe(2);
      expect(JSON.parse(out.at(-1)!)).toMatchObject({ schema: 'org.error.v1', command: 'org', error: { code: 'usage' } });
      expect(mocks.read).not.toHaveBeenCalled();
      mocks.read.mockRejectedValueOnce(new Error('fixture failure'));
      expect(await cmdOrg([])).toBe(1);
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});
