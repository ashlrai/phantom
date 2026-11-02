import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { emptyState, parseState } from '../src/core/drive/nodes/state.js';
import { AGENT_ENV_MARKERS, appendEvent, ownerConfigPath, readEvents } from '../src/core/teams/index.js';
import {
  TenancyError, assertOwnerAccess, assertTeamAccess, orgAdd, orgList, orgsPath, parseOwner, visibleTo, whoami,
} from '../src/core/tenancy/index.js';
import { callNativeTool } from '../src/core/mcp-native.js';

// Synthetic credential-shaped value; never a real token.
const SECRET = `ghp_${'A1b2C3d4'.repeat(5)}`;
const T = 'platform';
const saved: Record<string, string | undefined> = {};
let home: string; let prev: string | undefined;

function pin(human: string) { const p = ownerConfigPath(); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify({ human })); }
async function cli(fn: () => Promise<number>) {
  const out: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((s: unknown) => { out.push(String(s)); });
  const err = vi.spyOn(console, 'error').mockImplementation((s: unknown) => { out.push(String(s)); });
  try { return { code: await fn(), out: out.join('\n') }; } finally { log.mockRestore(); err.mockRestore(); }
}
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await callNativeTool(name, args);
  return { err: r.isError === true, body: r.content[0]!.text };
};

beforeEach(() => {
  prev = process.env['ASHLR_HOME']; home = mkdtempSync(join(tmpdir(), 'phm-tenancy-')); process.env['ASHLR_HOME'] = home;
  for (const k of AGENT_ENV_MARKERS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  if (prev === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = prev;
  rmSync(home, { recursive: true, force: true });
  for (const k of AGENT_ENV_MARKERS) if (saved[k] !== undefined) process.env[k] = saved[k];
});

/** Mason founds team "platform"; evan is a different local identity on a shared log. */
function twoTenants() {
  pin('mason');
  appendEvent(T, { kind: 'human', id: 'human:mason' }, 'member.joined', {});
}

describe('identity: whoami and org list', () => {
  it('derives person, teams, orgs and sorted scopes from local auth only', () => {
    twoTenants();
    expect(orgAdd('acme', [T]).action).toBe('created');
    expect(orgAdd('acme', [T]).action).toBe('unchanged');
    const me = whoami();
    expect(me).toEqual({ schemaVersion: 1, person: 'mason', actor: 'human', teams: [{ id: T, role: 'owner' }],
      orgs: ['acme'], scopes: ['org:acme', 'person:mason', 'team:platform'] });
    expect(whoami()).toEqual(me); // deterministic
    expect(whoami({ CLAUDECODE: '1' }).actor).toBe('agent');
  });

  it('lists only orgs you belong to', () => {
    mkdirSync(dirname(orgsPath()), { recursive: true });
    writeFileSync(orgsPath(), JSON.stringify({ version: 1, orgs: [{ id: 'other', members: ['evan'], teams: [] }] }));
    pin('mason');
    orgAdd('acme');
    expect(orgList().orgs.map(o => o.id)).toEqual(['acme']);
    pin('evan');
    expect(orgList().orgs.map(o => o.id)).toEqual(['other']);
  });

  it('corrupt org config fails with a fix, never silently resets', () => {
    pin('mason');
    mkdirSync(dirname(orgsPath()), { recursive: true });
    writeFileSync(orgsPath(), '{nope');
    expect(() => whoami()).toThrow(TenancyError);
    try { whoami(); } catch (e) { expect((e as TenancyError).fix).toContain('phm org add'); }
    expect(readFileSync(orgsPath(), 'utf8')).toBe('{nope');
  });

  it('CLI prints --json and plain English, with self-fixing errors', async () => {
    twoTenants();
    const { cmdWhoami, cmdOrg } = await import('../src/cli/tenancy.js');
    const j = await cli(() => cmdWhoami(['--json']));
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out).scopes).toEqual(['person:mason', 'team:platform']);
    expect((await cli(() => cmdWhoami([]))).out).toContain('teams: platform (owner)');
    expect(JSON.parse((await cli(() => cmdOrg(['add', 'acme', '--team', T, '--json']))).out).action).toBe('created');
    expect(JSON.parse((await cli(() => cmdOrg(['list', '--json']))).out).orgs).toEqual([{ id: 'acme', members: ['mason'], teams: [T] }]);
    const bad = await cli(() => cmdOrg(['add', 'Bad Org', '--json']));
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toMatchObject({ error: expect.stringContaining('Invalid owner'), fix: expect.stringContaining('org:<id>') });
    const usage = await cli(() => cmdOrg(['frobnicate']));
    expect(usage.code).toBe(2);
    expect(usage.out).toContain('fix: Usage: phm org');
  });
});

describe('scope enforcement', () => {
  it('owner access is limited to the principal scopes', () => {
    twoTenants();
    expect(() => assertOwnerAccess(parseOwner('team:platform'))).not.toThrow();
    expect(() => assertOwnerAccess(parseOwner('team:billing'))).toThrow(/not in scope team:billing/);
    expect(() => assertOwnerAccess(parseOwner('person:evan'))).toThrow(TenancyError);
    expect(() => parseOwner('guild:x')).toThrow(/Invalid owner/);
    expect(visibleTo([{ id: 1, owner: parseOwner('team:platform') }, { id: 2, owner: parseOwner('team:billing') }, { id: 3 }],
      whoami().scopes).map(x => x.id)).toEqual([1, 3]);
  });

  it('a message under a claimed --as name never claims a team', async () => {
    pin('mason');
    appendEvent(T, { kind: 'human', id: 'human:spoof' }, 'message.posted', { text: 'mine now' });
    expect(() => assertTeamAccess(T)).not.toThrow();
  });
});

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

describe('cross-tenant isolation: jobs, leases and logs', () => {
  function fleet() {
    const store = new MemoryStore();
    const nodes = new DriveNodes(store, { now: () => 1_000 });
    const a = nodes.join('node-a', parseOwner('team:platform'))!;
    const b = nodes.join('node-b', parseOwner('team:billing'))!;
    const leader = nodes.heartbeat(a)!.leader!;
    nodes.heartbeat(b);
    return { store, nodes, a, b, leader };
  }

  it('a job and its lease never run on another tenant node', () => {
    const f = fleet();
    expect(f.nodes.enqueue('job-1', parseOwner('team:platform'))).toBe(true);
    expect(() => f.nodes.claim(f.leader, f.b, 'job-1')).toThrow(/cannot run on node node-b \(team:billing\)/);
    expect(f.store.state.jobs[0]!.state).toBe('pending'); // refusal commits nothing
    expect(f.nodes.claim(f.leader, f.a, 'job-1')!.nodeId).toBe('node-a');
    f.nodes.enqueue('legacy');
    expect(() => f.nodes.claim(f.leader, f.a, 'legacy')).toThrow(TenancyError);
  });

  it('results are scrubbed of secrets before they become shared logs', () => {
    const f = fleet();
    f.nodes.enqueue('job-1', parseOwner('team:platform'));
    const claim = f.nodes.claim(f.leader, f.a, 'job-1')!;
    expect(f.nodes.complete(claim, `deployed with ${SECRET}`)).toBe(true);
    expect(JSON.stringify(f.store.state)).not.toContain(SECRET);
  });

  it('views are owner-filtered and corrupt owners are rejected', () => {
    const f = fleet();
    expect(visibleTo(f.nodes.snapshot().nodes, ['team:platform']).map(n => n.nodeId)).toEqual(['node-a']);
    const bad = structuredClone(f.store.state) as unknown as { nodes: { owner: unknown }[] };
    bad.nodes[0]!.owner = { kind: 'guild', id: 'x' };
    expect(() => parseState(bad)).toThrow('Invalid drive nodes state');
  });
});

describe('cross-tenant isolation: forum threads and context packs', () => {
  it('another tenant cannot read or post to a claimed team', async () => {
    twoTenants();
    expect((await call('phm_team_context_add', { team: T, agentId: 'codex/mason', title: 'Deploy', text: 'Deploys run from main.', source: 'docs/x.md', owner: 'company' })).err).toBe(false);
    expect((await call('phm_team_publish', { team: T, agentId: 'codex/mason', channel: 'release', text: 'Shipping today' })).err).toBe(false);
    pin('evan');
    for (const [tool, args] of [
      ['phm_team_context_get', { team: T, query: 'deploy', owner: 'company' }],
      ['phm_team_view', { team: T }],
      ['phm_team_publish', { team: T, agentId: 'codex/evan', text: 'hi' }],
      ['phm_team_register', { team: T, agentId: 'codex/evan' }],
    ] as const) {
      const r = await call(tool, args);
      expect(r.err).toBe(true);
      expect(r.body).toContain('belongs to another tenant');
      expect(r.body).toContain('phm team invite human:evan --team platform');
    }
    const { cmdTeam } = await import('../src/cli/team.js');
    const view = await cli(() => cmdTeam(['view', '--team', T]));
    expect(view.code).toBe(1);
    expect(view.out).toContain('fix: Ask a team owner');
    expect(view.out).not.toContain('Shipping today');
    expect((await cli(() => cmdTeam(['join', '--team', T]))).code).toBe(1);
    expect(readEvents(T).filter(e => e.actor.id.includes('evan'))).toEqual([]);
  });

  it('an invited member gains access; secrets never enter forum or pack', async () => {
    twoTenants();
    appendEvent(T, { kind: 'human', id: 'human:mason' }, 'member.invited', { memberId: 'human:evan', role: 'member' });
    pin('evan');
    expect(() => assertTeamAccess(T)).not.toThrow();
    expect((await call('phm_team_publish', { team: T, agentId: 'codex/evan', text: `token ${SECRET}` })).err).toBe(true);
    expect((await call('phm_team_context_add', { team: T, agentId: 'codex/evan', title: 'Creds', text: `use ${SECRET}`, source: 'x', owner: 'company' })).err).toBe(true);
    const pack = await call('phm_team_context_get', { team: T, query: 'creds', owner: 'company' });
    expect(pack.err).toBe(false);
    expect(pack.body).not.toContain(SECRET);
    expect(readFileSync(join(home, 'teams', T, 'events.jsonl'), 'utf8')).not.toContain(SECRET);
  });
});
