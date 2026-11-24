/**
 * `phm org` as an org chart: leader, planners, lanes, jobs. Three fleets: empty, normal, and one with a held lane.
 * Everything is built by the same pure functions the server and the CLI use; nothing here reads the real home.
 */
import { describe, expect, it } from 'vitest';
import type { FleetLiveSnapshotV1 } from '../src/core/fleet/fleet-types.js';
import { fleetOrgMap } from '../src/core/fleet/org-map.js';
import { fleetOrgTree, renderOrgTreeText, type FleetOrgTree } from '../src/core/fleet/org-tree.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import type { FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';
import type { FleetEdges } from '../src/core/fleet/fleet-edges.js';

const NOW = Date.parse('2026-11-18T12:00:00Z'), AT = '2026-11-18T12:00:00Z';
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const session = (job: string, lane: string, tier: string, minutes: number) => ({ job, lane, tier, repo: 'phantom', model: 'fixture-model', status: 'running',
  elapsedSeconds: minutes * 60, startedAt: ago(minutes), live: 'yes' });
const lane = (name: string, running: number, target: number, extra: object = {}) => ({ lane: name, running, target, queued: 0, held: false, heldReason: null, ...extra });
const messages = (edges: { from: string; to: string; minutes: number }[]): FleetEdges => ({ schema: 'fleet.edges.v1', source: 'available',
  edges: edges.map(edge => ({ from: { address: edge.from, provider: null }, to: { address: edge.to, provider: null }, messages: 1, messagesLastHour: 1, lastAt: NOW - edge.minutes * 60_000 })) } as unknown as FleetEdges);

function fleet(input: { sessions: object[]; lanes: object[]; events?: object[]; edges?: FleetEdges; snapshot?: FleetLiveSnapshotV1 }): FleetOrgTree {
  const map = fleetOrgMap(input.snapshot ?? null, { now: NOW, messages: input.edges ?? messages([]),
    sessions: { generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions: input.sessions } as unknown as FleetSessionsV1 });
  const runs = { lanes: input.lanes, events: input.events ?? [], lastTick: AT, paused: false, sources: { status: 'healthy', events: 'healthy' } } as unknown as FleetRunsDirState;
  // The JSON round trip is what `phm org --json` and the API send.
  return JSON.parse(JSON.stringify(fleetOrgTree(map, { runs }))) as FleetOrgTree;
}
const find = (tree: FleetOrgTree, name: string) => tree.lanes.find(row => row.lane === name)!;
const planner = (tree: FleetOrgTree, id: string) => tree.planners!.find(row => row.id === id)!;

describe('org chart', () => {
  it('empty fleet: leader idle, planners unknown, every lane idle with its reason, no jobs', () => {
    const tree = fleet({ sessions: [], lanes: [lane('claude', 0, 8), lane('zai', 0, 0)] });
    expect(tree).toMatchObject({ schema: 'fleet.org.v1', version: 1, jobsKnown: true });
    expect(tree.leader).toMatchObject({ state: 'idle', doing: 'No jobs running' });
    expect(tree.planners!.map(row => row.label)).toEqual(['Executor', 'Core orchestrator', 'Main guardian', 'Comms']);
    // A short dispatch tail or message window with no sign proves nothing: unknown, never idle.
    expect(tree.planners!.map(row => row.state)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(planner(tree, 'executor').doing).toBe('Unknown: no sign in the recent dispatch log');
    expect(planner(tree, 'comms').doing).toBe('Unknown: no messages in this window');
    expect(find(tree, 'claude')).toMatchObject({ state: 'idle', doing: 'Idle, nothing queued', running: 0, target: 8, jobs: [] });
    expect(find(tree, 'zai')).toMatchObject({ state: 'idle', doing: 'Turned off (0 seats)', target: 0 });
    const text = renderOrgTreeText(tree, NOW);
    expect(text).toContain('Leader (CEO): idle. No jobs running.');
    expect(text).toContain('  Planners:\n    Executor: unknown. Unknown: no sign in the recent dispatch log. Last sign unknown.');
    expect(text).toContain('zai (Z.ai, model unknown): idle. Turned off (0 seats). 0 running of 0, 0 queued');
  });

  it('normal fleet: planners from dispatch events and messages, jobs with id, repo, tier, age and a one-line goal', () => {
    const snapshot = { generatedAt: AT, state: 'running', lanes: [], runs: [{ id: 'attempt-1', taskId: 'RQ-A', title: 'Fix the login\n  redirect', repo: 'phantom',
      lane: 'claude', phase: 'producing', endedAt: null, outcome: null, startedAt: ago(12) }] } as unknown as FleetLiveSnapshotV1;
    const tree = fleet({ snapshot,
      sessions: [session('RQ-A', 'claude', 'frontier', 12), session('RQ-B', 'codex-personal', 'work', 90)],
      lanes: [lane('claude', 1, 8, { queued: 2 }), lane('codex-personal', 1, 20)],
      events: [{ at: ago(3), kind: 'LEADER', text: 'planned 2' }, { at: ago(120), kind: 'ORCH-JOB', text: 'RQ-B from claude' }],
      edges: messages([{ from: 'Guardian', to: 'leader', minutes: 4 }]) });
    expect(tree.leader).toMatchObject({ state: 'running', doing: 'Directing 2 running jobs across 2 lanes' });
    expect(planner(tree, 'executor')).toMatchObject({ state: 'running', doing: 'Active', lastActivityAt: ago(3) });
    expect(planner(tree, 'orchestrator')).toMatchObject({ state: 'idle', doing: 'Quiet for over 90 minutes' });
    expect(planner(tree, 'guardian')).toMatchObject({ state: 'running', doing: 'Active', lastActivityAt: ago(4) });
    expect(planner(tree, 'comms').state).toBe('unknown');
    expect(find(tree, 'claude')).toMatchObject({ provider: 'Anthropic', model: 'fixture-model', state: 'running', running: 1, target: 8, queued: 2 });
    expect(find(tree, 'claude').jobs).toEqual([expect.objectContaining({ id: 'RQ-A', repo: 'phantom', tier: 'frontier', ageSeconds: 720, goal: 'Fix the login redirect', state: 'running' })]);
    // A session row never carries its prompt, so a job with no engine title has an unknown goal.
    expect(find(tree, 'codex-personal').jobs[0]).toMatchObject({ id: 'RQ-B', tier: 'work', ageSeconds: 5400, goal: null });
    expect(tree.lanes.slice(0, 3).map(row => row.lane)).toEqual(['codex-personal', 'codex-cmp', 'claude']);
    const text = renderOrgTreeText(tree, NOW);
    expect(text).toContain('Executor: running. Active. Last sign 3m ago.');
    expect(text).toContain('Main guardian: running. Active. Last sign 4m ago.');
    expect(text).toMatch(/RQ-A \| running \| Working in phantom \| fixture-model \| started 12m ago \| .* \| tier frontier \| goal Fix the login redirect/);
    expect(text).toContain('| tier work | goal unknown');
  });

  it('held lane: grey with the reason in plain words, still showing a job it already runs', () => {
    const tree = fleet({ sessions: [session('RQ-C', 'devin', 'mid', 30)],
      lanes: [lane('devin', 1, 0, { held: true, heldReason: 'usage limit reached' }), lane('gemini', 0, 1, { held: true })] });
    expect(find(tree, 'devin')).toMatchObject({ state: 'held', held: true, doing: 'Held: usage limit reached', heldReason: 'usage limit reached', running: 1, target: 0 });
    expect(find(tree, 'devin').jobs.map(job => job.id)).toEqual(['RQ-C']);
    expect(find(tree, 'gemini')).toMatchObject({ state: 'held', doing: 'Held, reason not reported' });
    expect(tree.leader).toMatchObject({ state: 'running', doing: 'Directing 1 running job across 1 lane' });
    const text = renderOrgTreeText(tree, NOW);
    expect(text).toContain('devin (Cognition, fixture-model): held. Held: usage limit reached. 1 running of 0, 0 queued, held');
    expect(text).toContain('gemini (Google, model unknown): held. Held, reason not reported.');
  });

  it('an unread dispatch log and bus keep every planner unknown, and an older server tree without planners still renders', () => {
    const map = fleetOrgMap(null, { now: NOW });
    const tree = fleetOrgTree(map);
    expect(tree.planners!.map(row => [row.state, row.doing])).toEqual([
      ['unknown', 'Unknown: the dispatch log could not be read'], ['unknown', 'Unknown: the dispatch log could not be read'],
      ['unknown', 'Unknown: agent messages could not be read'], ['unknown', 'Unknown: agent messages could not be read']]);
    const old = { ...tree }; delete old.planners;
    expect(renderOrgTreeText(old, NOW)).not.toContain('Planners');
  });
});
