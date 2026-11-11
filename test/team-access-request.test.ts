import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendEvent, decideApproval, readEvents, readTeamAudit, requestAccess, teamState, updateWorkspace, type TeamActor,
} from '../src/core/teams/index.js';
import { ownerConfigPath } from '../src/core/teams/index.js';
import { AGENT_ENV_MARKERS } from '../src/core/teams/identity.js';
import { callNativeTool } from '../src/core/mcp-native.js';
import { cmdTeam } from '../src/cli/team.js';

const mason: TeamActor = { kind: 'human', id: 'human:mason' };
const evan: TeamActor = { kind: 'human', id: 'human:evan' };
const codex: TeamActor = { kind: 'agent', id: 'agent:codex/acct-2', provider: 'codex', onBehalfOf: 'human:mason' };
const T = 'access-test';
function pinOwner(human: string) { const p = ownerConfigPath(); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify({ human })); }
let home: string; let prev: string | undefined;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  prev = process.env['ASHLR_HOME'];
  home = mkdtempSync(join(tmpdir(), 'phm-access-'));
  process.env['ASHLR_HOME'] = home;
  for (const k of AGENT_ENV_MARKERS) { saved[k] = process.env[k]; delete process.env[k]; }
  pinOwner('mason');
  appendEvent(T, mason, 'member.joined', {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (prev === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = prev;
  rmSync(home, { recursive: true, force: true });
  for (const k of AGENT_ENV_MARKERS) if (saved[k] !== undefined) process.env[k] = saved[k];
});

const approvalOf = (id: string) => teamState(T).approvals.find((a) => a.id === id);

describe('agent access requests', () => {
  it('request -> pending approval -> human approve -> member.invited with the human as actor', () => {
    const r = requestAccess(T, codex, { type: 'member.invited', memberId: 'human:evan' }, 'needs evan on RQ-123');
    expect(r).toMatchObject({ state: 'pending', deduped: false });
    const a = approvalOf(r.approvalId)!;
    expect(a).toMatchObject({ handoffId: null, action: null, access: { type: 'member.invited', memberId: 'human:evan' }, note: 'needs evan on RQ-123', requestedBy: codex.id, state: 'pending' });
    expect(teamState(T).members.some((m) => m.id === evan.id)).toBe(false);

    const d = decideApproval(T, mason, r.approvalId, 'approve');
    expect(d).toMatchObject({ approvalId: r.approvalId, state: 'approved', applied: { type: 'member.invited' } });
    const st = teamState(T);
    expect(st.members.find((m) => m.id === evan.id)).toMatchObject({ kind: 'human', role: 'member' });
    expect(approvalOf(r.approvalId)).toMatchObject({ state: 'approved', decidedBy: mason.id });

    // The audit trail is true actor attribution: agent requested, human decided, human invited.
    const invited = readEvents(T).find((e) => e.type === 'member.invited')!;
    expect(invited.actor).toEqual(mason);
    expect(invited.payload).toMatchObject({ memberId: evan.id, role: 'member', approvalId: r.approvalId });
    const audit = readTeamAudit(T).map((e) => [e.type, e.actor.id]);
    expect(audit.slice(0, 3)).toEqual([['member.invited', mason.id], ['access.requested', codex.id], ['member.joined', mason.id]]);
  });

  it('approved link-repo applies repo.linked with provenance', () => {
    const r = requestAccess(T, codex, { type: 'repo.linked', repo: 'AshlrAI/Phantom' });
    expect(approvalOf(r.approvalId)?.access).toEqual({ type: 'repo.linked', repo: 'ashlrai/phantom' });
    const d = decideApproval(T, mason, r.approvalId, 'approve');
    expect(d).toMatchObject({ state: 'approved', applied: { type: 'repo.linked' } });
    expect(teamState(T).repos).toEqual(['ashlrai/phantom']);
    const ev = readEvents(T).at(-1)!;
    expect(ev.type).toBe('repo.linked');
    expect(ev.actor).toEqual(mason);
    expect(ev.payload).toMatchObject({ repo: 'ashlrai/phantom', approvalId: r.approvalId });
  });

  it('approved change-role applies member.role-changed', () => {
    updateWorkspace(T, mason, { type: 'member.invited', memberId: 'human:evan' });
    const r = requestAccess(T, codex, { type: 'member.role-changed', memberId: 'human:evan', role: 'admin' });
    expect(decideApproval(T, mason, r.approvalId, 'approve')).toMatchObject({ state: 'approved', applied: { type: 'member.role-changed' } });
    expect(teamState(T).members.find((m) => m.id === evan.id)?.role).toBe('admin');
    const ev = readEvents(T).at(-1)!;
    expect(ev.payload).toMatchObject({ memberId: evan.id, previousRole: 'member', role: 'admin', approvalId: r.approvalId });
  });

  it('a denied request mutates nothing', () => {
    const r = requestAccess(T, codex, { type: 'member.invited', memberId: 'human:evan' });
    const before = readEvents(T).length;
    expect(decideApproval(T, mason, r.approvalId, 'deny').state).toBe('denied');
    const st = teamState(T);
    expect(st.members.some((m) => m.id === evan.id)).toBe(false);
    expect(approvalOf(r.approvalId)).toMatchObject({ state: 'denied', decidedBy: mason.id });
    // Only the decision was appended; no mutation events followed.
    const tail = readEvents(T).slice(before);
    expect(tail.map((e) => e.type)).toEqual(['approval.decided']);
  });

  it('agents can never decide: self-approve, spoofed human id and member-role humans all fail', () => {
    const r = requestAccess(T, codex, { type: 'member.invited', memberId: 'human:evan' });
    const before = readEvents(T);
    expect(() => decideApproval(T, codex, r.approvalId, 'approve')).toThrow(/humans/);
    expect(() => decideApproval(T, { kind: 'human', id: 'agent:codex/acct-2' }, r.approvalId, 'approve')).toThrow(/humans/);
    expect(() => decideApproval(T, { kind: 'human', id: 'human:impostor' }, r.approvalId, 'approve')).toThrow(/derived locally/);
    // A human member (not owner/admin) cannot decide either.
    updateWorkspace(T, mason, { type: 'member.invited', memberId: 'human:guest' });
    pinOwner('guest');
    expect(() => decideApproval(T, { kind: 'human', id: 'human:guest' }, r.approvalId, 'approve')).toThrow(/not applied/);
    pinOwner('mason');
    expect(readEvents(T).length).toBe(before.length + 2);
    expect(approvalOf(r.approvalId)?.state).toBe('pending');
    expect(teamState(T).members.some((m) => m.id === 'human:evan')).toBe(false);
  });

  it('an agent process cannot approve even from the owner identity', () => {
    const r = requestAccess(T, codex, { type: 'repo.linked', repo: 'a/b' });
    const before = readEvents(T);
    vi.stubEnv('CODEX_THREAD_ID', 'x');
    expect(() => decideApproval(T, mason, r.approvalId, 'approve')).toThrow(/agent process/);
    expect(readEvents(T)).toEqual(before);
    expect(approvalOf(r.approvalId)?.state).toBe('pending');
    expect(teamState(T).repos).toEqual([]);
  });

  it('a request that went stale stays pending for a deny instead of half-applying', () => {
    const r = requestAccess(T, codex, { type: 'member.invited', memberId: 'human:evan' });
    updateWorkspace(T, mason, { type: 'member.invited', memberId: 'human:evan' });
    const before = readEvents(T).length;
    expect(() => decideApproval(T, mason, r.approvalId, 'approve')).toThrow(/Member already exists/);
    expect(approvalOf(r.approvalId)?.state).toBe('pending');
    expect(readEvents(T).length).toBe(before);
    expect(decideApproval(T, mason, r.approvalId, 'deny').state).toBe('denied');
    expect(teamState(T).members.find((m) => m.id === evan.id)?.role).toBe('member');
  });

  it('identical pending requests dedupe to one approval', () => {
    const a = requestAccess(T, codex, { type: 'repo.linked', repo: 'a/b' });
    const b = requestAccess(T, codex, { type: 'repo.linked', repo: 'a/b' }, 'retry after restart');
    const c = requestAccess(T, { kind: 'agent', id: 'agent:grok-bot/mason' }, { type: 'repo.linked', repo: 'A/B' });
    expect(b).toMatchObject({ approvalId: a.approvalId, deduped: true });
    expect(c).toMatchObject({ approvalId: a.approvalId, deduped: true });
    expect(readEvents(T).filter((e) => e.type === 'access.requested')).toHaveLength(1);
    // Once decided the request no longer dedupes; a fresh request gets its own approval.
    decideApproval(T, mason, a.approvalId, 'deny');
    const d = requestAccess(T, codex, { type: 'repo.linked', repo: 'a/b' });
    expect(d).toMatchObject({ deduped: false });
    expect(d.approvalId).not.toBe(a.approvalId);
    expect(decideApproval(T, mason, d.approvalId, 'approve')).toMatchObject({ state: 'approved', applied: { type: 'repo.linked' } });
    expect(teamState(T).repos).toEqual(['a/b']);
  });

  it('validates requests up front instead of parking noise in the queue', () => {
    const bad: unknown[] = [
      { type: 'member.invited', memberId: 'agent:bot' },
      { type: 'member.invited', memberId: 'not a human id' },
      { type: 'member.invited' },
      { type: 'member.role-changed', memberId: 'human:evan', role: 'owner' },
      { type: 'member.role-changed', memberId: 'human:ghost', role: 'admin' },
      { type: 'member.role-changed', memberId: 'human:mason', role: 'member' },
      { type: 'member.removed', memberId: 'human:evan' },
      { type: 'repo.linked', repo: '../escape/path' },
      { type: 'repo.linked', repo: 'noslash' },
      { type: 'agent.registered', capabilities: [] },
      'member.invited', null, 42,
    ];
    for (const request of bad) expect(() => requestAccess(T, codex, request), `request: ${JSON.stringify(request)}`).toThrow();
    expect(teamState(T).approvals).toEqual([]);
    expect(readEvents(T).filter((e) => e.type === 'access.requested')).toEqual([]);
  });

  it('rejects requests that cannot apply today', () => {
    updateWorkspace(T, mason, { type: 'member.invited', memberId: 'human:evan' });
    updateWorkspace(T, mason, { type: 'repo.linked', repo: 'a/b' });
    expect(() => requestAccess(T, codex, { type: 'member.invited', memberId: 'human:evan' })).toThrow(/already exists/);
    expect(() => requestAccess(T, codex, { type: 'repo.linked', repo: 'A/B' })).toThrow(/already linked/);
    expect(() => requestAccess(T, codex, { type: 'member.role-changed', memberId: 'human:evan', role: 'member' })).toThrow(/already has that role/);
    expect(teamState(T).approvals).toEqual([]);
  });

  it('refuses credential-shaped notes through the shared scrub gate', () => {
    expect(() => requestAccess(T, codex, { type: 'repo.linked', repo: 'a/b' }, 'key sk-ant-api03-' + 'a'.repeat(90))).toThrow(/Phantom Secrets/);
    expect(teamState(T).approvals).toEqual([]);
  });

  it('MCP tool end to end: request, view, human approve applies the mutation', async () => {
    const call = async (args: Record<string, unknown>) => {
      const r = await callNativeTool('phm_team_access_request', { team: T, ...args });
      return { err: r.isError === true, body: r.content[0]!.text };
    };
    expect((await call({ agentId: 'codex/acct-2', op: 'bogus' })).err).toBe(true);
    expect((await call({ agentId: 'codex/acct-2', op: 'invite-member' })).err).toBe(true);
    const ok = await call({ agentId: 'codex/acct-2', op: 'invite-member', memberId: 'human:evan', note: 'RQ-TEAM-AGENT-ACCESS-1' });
    expect(ok.err).toBe(false);
    const req = JSON.parse(ok.body) as { approvalId: string; state: string };
    expect(req.state).toBe('pending');
    const view = JSON.parse((await callNativeTool('phm_team_view', { team: T })).content[0]!.text) as { approvals: { id: string; access: unknown; state: string }[] };
    expect(view.approvals).toHaveLength(1);
    expect(view.approvals[0]).toMatchObject({ id: req.approvalId, access: { type: 'member.invited', memberId: 'human:evan' }, state: 'pending' });
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdTeam(['approve', req.approvalId, '--team', T])).toBe(0);
      expect(String(out.mock.calls.at(-1)?.[0])).toContain('applied member.invited');
    } finally { out.mockRestore(); }
    expect(teamState(T).members.find((m) => m.id === evan.id)?.role).toBe('member');
    expect((await call({ agentId: 'codex/acct-2', op: 'change-role', memberId: 'human:evan', role: 'admin' })).err).toBe(false);
    expect((await call({ agentId: 'codex/acct-2', op: 'link-repo', repo: 'a/b' })).err).toBe(false);
    expect(teamState(T).approvals).toHaveLength(3);
  });
});
