import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectAgentRoster, parseRosterViewOptions, projectRosterView, selectAgentRoster,
  type AgentRosterDeps, type RosterSession } from '../src/core/fleet/agent-roster.js';
import { runAgentsRosterCli } from '../src/cli/agents-roster.js';
import { parseFleetAgentRosterArgs, selectFleetAgentRoster } from '../src/mcp/fleet-agent-roster.js';

const foreign = 'own_' + 'b'.repeat(32), seen = '2026-11-24T08:29:13.999Z';
const forbidden = ['sessionId', 'title', 'url', 'org', 'deviceId', 'machineName', 'load', 'memory', 'usage', 'eid'];
const fixture = (): RosterSession => ({
  provider: 'phantom', sessionId: 'private-session-marker', title: 'private-title-marker',
  state: 'running', ownership: 'private-lane-marker', claims: [], lastActivity: seen, blockers: [],
  handle: 'reviewer', principal: foreign, kind: 'external',
  url: 'https://private-url-marker.example', org: 'private-org-marker',
  ...Object.fromEntries(['deviceId', 'machineName', 'load', 'memory', 'usage', 'eid'].map(key => [key, `private-${key}-marker`])),
});
function harness(): AgentRosterDeps {
  return {
    now: () => Date.parse(seen),
    listPhantom: async () => ({ v: 1, generatedAt: seen, sourceState: 'healthy',
      workers: [{ pid: 7, job: 'private-session-marker', repo: 'private-title-marker', lane: 'worker', tier: 'work', ageSeconds: 12 }],
      leaders: [], orchestratorAgents: 0 }),
    listDevinCloud: async () => ({ unavailable: 'fixture' }), readDevinCliRoster: async () => null,
    exec: async () => ({ stdout: '', stderr: '', code: null, timedOut: false, missing: true }),
    fetchLoopback: async () => ({ unavailable: true }), readClaims: () => ({ source: 'missing', claims: [] }),
    readMesh: () => ({ status: 'ok', schema: 'agent-mesh.v1', asOf: Date.parse(seen), agents: [{
      agent: 'imsg-helper', address: 'agent:imsg-helper', displayName: 'private-title-marker', provider: null,
      lane: 'imessage', lastSeen: Date.parse(seen), currentTask: 'private-task-marker',
      status: 'unknown', source: 'imessage', observedAt: Date.parse(seen),
    }] }),
  };
}
function keys(value: unknown): string[] {
  return !value || typeof value !== 'object' ? [] : Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)]);
}
describe('M2-4 reduced multi-owner roster', () => {
  it('M2-4 projects exactly four coarse fields with no forbidden deep keys or values', () => {
    const view = projectRosterView([fixture()]);
    expect(view).toEqual([{ qualifiedHandle: { handle: 'reviewer', owner: foreign }, kind: 'external',
      status: 'active', lastSeen: '2026-11-24T08:15:00.000Z' }]);
    expect(keys(view).filter(key => forbidden.includes(key))).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('private-');
  });
  it('M2-4 uses null for unenrolled identities and never falls back to session ids or arbitrary text', () => {
    const row = fixture();
    expect(projectRosterView([{ ...row, principal: 'local', state: 'private-status-marker', lastActivity: 'private-time-marker' }]))
      .toEqual([{ qualifiedHandle: null, kind: 'external', status: 'unknown', lastSeen: null }]);
    expect(projectRosterView([{ ...row, handle: row.sessionId + '@peer' }])[0]?.qualifiedHandle).toBeNull();
  });
  it('M2-4 names owner identity principal and preserves claim owner as a lane label', () => {
    const source = readFileSync(new URL('../src/core/fleet/agent-roster.ts', import.meta.url), 'utf8');
    const session = source.match(/export interface RosterSession \{([\s\S]*?)\n\}/)![1]!;
    expect(session).toContain('principal?:');
    expect(session).not.toMatch(/^\s*owner\??:/m);
    expect(source.match(/export interface RosterClaimRef \{([\s\S]*?)\n\}/)![1]).toMatch(/^\s*owner: string;/m);
  });
  it('M2-4 defaults local rows to local principal and external mesh rows to unverified', async () => {
    const roster = await collectAgentRoster(harness());
    expect(roster.sessions[0]).toMatchObject({ principal: 'local', kind: 'local' });
    expect(roster.members).toEqual([expect.objectContaining({ handle: 'imsg-helper', principal: null,
      kind: 'external', principalReason: 'unverified' })]);
    expect(selectAgentRoster(roster, { principal: 'local' })).toMatchObject({ members: [] });
    const deps = harness(), readMesh = deps.readMesh!;
    deps.readMesh = () => ({ ...readMesh(), agents: readMesh().agents.map(row => ({ ...row, agent: 'imsg-dot', source: 'registry' as const })) });
    expect((await collectAgentRoster(deps)).members?.[0]).toMatchObject({ principal: null, kind: 'external' });
  });
  it('M2-4 filters foreign principals and reduces CLI and fleet MCP results', async () => {
    const roster = await collectAgentRoster(harness());
    roster.sessions.push(fixture());
    const expected = projectRosterView([fixture()]);
    expect(selectAgentRoster(roster, { principal: foreign })).toEqual(expected);
    expect(selectFleetAgentRoster(roster, { principal: foreign })).toEqual(expected);
    const output: string[] = [];
    expect(await runAgentsRosterCli(['--all-owners', '--json'], text => output.push(text), undefined, harness())).toBe(0);
    const view = JSON.parse(output[0]!) as unknown[];
    expect(view).toHaveLength(2);
    for (const row of view) expect(Object.keys(row as object).sort()).toEqual(['kind', 'lastSeen', 'qualifiedHandle', 'status']);
    expect(JSON.stringify(view)).not.toContain('private-');
  });
  it('M2-4 selectors reject malformed principals, caller roots and conflicting views', () => {
    for (const input of [{ principal: 'owner-b' }, { principal: 'local', allOwners: true },
      { allOwners: 'true' }, { root: '/tmp/fixture' }]) {
      expect(parseRosterViewOptions(input)).toBeNull();
      expect(parseFleetAgentRosterArgs(input)).toBeNull();
    }
  });
});
