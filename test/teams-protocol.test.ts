import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireClaim, addContext, appendEvent, claimsOverlap, decideApproval, foldTeam, importEvents,
  readEvents, releaseClaim, requestHandoff, retrieveContext, teamState, transitionHandoff, type TeamActor,
} from '../src/core/teams/index.js';
import { callNativeTool } from '../src/core/mcp-native.js';

const mason: TeamActor = { kind: 'human', id: 'human:mason' };
const evan: TeamActor = { kind: 'human', id: 'human:evan' };
const grok: TeamActor = { kind: 'agent', id: 'agent:grok-bot/mason', provider: 'grok-bot', onBehalfOf: 'human:mason' };
const codex: TeamActor = { kind: 'agent', id: 'agent:codex/acct-2', provider: 'codex' };
const T = 'ashlr';
let home: string; let prev: string | undefined;

beforeEach(() => { prev = process.env['ASHLR_HOME']; home = mkdtempSync(join(tmpdir(), 'phm-teams-')); process.env['ASHLR_HOME'] = home; });
afterEach(() => { if (prev === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = prev; rmSync(home, { recursive: true, force: true }); });

describe('team protocol', () => {
  it('claim overlap semantics', () => {
    expect(claimsOverlap({ repo: 'a/b' }, { repo: 'a/b', branch: 'x' })).toBe(true);
    expect(claimsOverlap({ repo: 'a/b', branch: 'x' }, { repo: 'a/b', branch: 'y' })).toBe(false);
    expect(claimsOverlap({ repo: 'a/b', path: 'src' }, { repo: 'a/b', path: 'src/x.ts' })).toBe(true);
    expect(claimsOverlap({ repo: 'a/b', path: 'src' }, { repo: 'a/b', path: 'docs' })).toBe(false);
    expect(claimsOverlap({ repo: 'a/b' }, { repo: 'a/c' })).toBe(false);
  });

  it('first human is owner; presence and messages fold', () => {
    appendEvent(T, mason, 'member.joined', {});
    appendEvent(T, evan, 'member.joined', {});
    appendEvent(T, grok, 'agent.registered', { capabilities: ['email', 'research'] });
    appendEvent(T, grok, 'message.posted', { text: 'Wave 11 sent' });
    const st = teamState(T);
    expect(st.members.find((m) => m.id === mason.id)?.role).toBe('owner');
    expect(st.members.find((m) => m.id === evan.id)?.role).toBe('member');
    expect(st.members.find((m) => m.id === grok.id)).toMatchObject({ role: 'agent', online: true, capabilities: ['email', 'research'] });
    expect(st.messages.at(-1)?.text).toBe('Wave 11 sent');
  });

  it('members cannot self-promote', () => {
    appendEvent(T, mason, 'member.joined', {});
    appendEvent(T, evan, 'member.joined', { role: 'owner' });
    expect(teamState(T).members.find((m) => m.id === evan.id)?.role).toBe('member');
  });

  it('claims prevent collisions and release', () => {
    const a = acquireClaim(T, codex, { repo: 'ashlrai/phantom', branch: 'feat/x' }, 'feature');
    expect(a.ok).toBe(true);
    const b = acquireClaim(T, grok, { repo: 'ashlrai/phantom', branch: 'feat/x', path: 'src' }, 'docs');
    expect(b.ok).toBe(false);
    expect(acquireClaim(T, grok, { repo: 'ashlrai/phantom', branch: 'feat/y' }, 'other').ok).toBe(true);
    expect(() => releaseClaim(T, grok, (a as { claimId: string }).claimId)).toThrow(/holder/);
    releaseClaim(T, codex, (a as { claimId: string }).claimId);
    expect(acquireClaim(T, grok, { repo: 'ashlrai/phantom', branch: 'feat/x' }, 'docs').ok).toBe(true);
  });

  it('claims expire', () => {
    acquireClaim(T, codex, { repo: 'ashlrai/phantom' }, 'x', 60_000);
    expect(foldTeam(T, readEvents(T), Date.now() + 61_000).claims).toHaveLength(0);
  });

  it('plain handoff lifecycle', () => {
    const h = requestHandoff(T, grok, { to: codex.id, title: 'Fix SEO job' });
    expect(h.state).toBe('open');
    expect(() => transitionHandoff(T, grok, h.handoffId, 'accept')).toThrow();
    transitionHandoff(T, codex, h.handoffId, 'accept');
    expect(transitionHandoff(T, codex, h.handoffId, 'complete', 'PR #700').state).toBe('completed');
  });

  it('consequential handoffs need human owner approval; agents and members cannot approve', () => {
    appendEvent(T, mason, 'member.joined', {});
    appendEvent(T, evan, 'member.joined', {});
    const h = requestHandoff(T, codex, { title: 'Release 3.30', action: 'release' }) as { handoffId: string; approvalId: string; state: string };
    expect(h.state).toBe('awaiting-approval');
    expect(() => transitionHandoff(T, grok, h.handoffId, 'accept')).toThrow(/approval/);
    expect(() => decideApproval(T, grok, h.approvalId, 'approve')).toThrow(/humans/);
    expect(() => decideApproval(T, evan, h.approvalId, 'approve')).toThrow();
    expect(decideApproval(T, mason, h.approvalId, 'approve').state).toBe('approved');
    expect(transitionHandoff(T, grok, h.handoffId, 'accept').state).toBe('accepted');
  });

  it('refuses secrets anywhere in the log', () => {
    expect(() => appendEvent(T, grok, 'message.posted', { text: 'key sk-ant-api03-' + 'a'.repeat(90) })).toThrow(/Phantom Secrets/);
    expect(() => appendEvent(T, grok, 'message.posted', { text: 'token ghp_' + 'A1b2C3d4E5'.repeat(4) })).toThrow();
    expect(appendEvent(T, grok, 'message.posted', { text: 'use phm_OPENAI_API_KEY' }).id).toBeTruthy();
    expect(readEvents(T)).toHaveLength(1);
  });

  it('sync import is idempotent and team-scoped', () => {
    appendEvent(T, mason, 'member.joined', {});
    const evs = readEvents(T);
    expect(importEvents('peer', evs)).toBe(0);
    expect(importEvents(T, evs)).toBe(0);
    const foreign = { ...evs[0]!, id: 'zzzz-1', team: 'peer' };
    expect(importEvents('peer', [foreign, foreign])).toBe(1);
  });
});

describe('shared context', () => {
  const add = (owner: string, title: string, text: string, project?: string) =>
    addContext(T, grok, { title, text, source: 'test://' + title, scope: { owner: owner as 'company', project } });

  it('scopes never leak across clients or out of personal', () => {
    add('client:warren', 'Warren bid', 'The Warren County bid needs a Virginia certificate of good standing.');
    add('client:acme', 'Acme deploy', 'Acme deploys with Vercel and a certificate pinning step.');
    add('personal', 'Mason notes', 'Personal certificate renewal reminder.');
    add('company', 'Phantom release', 'Phantom releases go through the signed release pipeline.');
    const w = retrieveContext(T, { query: 'certificate', scope: { owner: 'client:warren' } });
    expect(w.items.map((i) => i.title)).toEqual(['Warren bid']);
    const c = retrieveContext(T, { query: 'certificate release', scope: { owner: 'company' } });
    expect(c.items.map((i) => i.title)).toEqual(['Phantom release']);
    expect(retrieveContext(T, { query: 'certificate', scope: { owner: 'personal' } }).items.map((i) => i.title)).toContain('Mason notes');
  });

  it('compresses under budget with provenance and dedupe', () => {
    const filler = Array.from({ length: 200 }, (_, i) => `Unrelated sentence number ${i} about weather.`).join(' ');
    add('company', 'Claims design', `Claims are leases on repos. ${filler} Claims expire after a TTL. Claims are leases on repos.`);
    const pack = retrieveContext(T, { query: 'claims leases ttl', scope: { owner: 'company' }, budgetTokens: 120 });
    expect(pack.usedTokens).toBeLessThanOrEqual(120);
    expect(pack.items[0]!.source).toBe('test://Claims design');
    expect(pack.items[0]!.excerpt).toContain('Claims expire after a TTL.');
    expect(pack.items[0]!.excerpt.match(/leases on repos/g)).toHaveLength(1);
    expect(pack.compressionRatio).toBeLessThan(0.2);
  });

  it('rejects context without provenance or with secrets', () => {
    expect(() => addContext(T, grok, { title: 'x', text: 'y', source: '', scope: { owner: 'company' } })).toThrow(/provenance/);
    expect(() => add('company', 'leak', 'AWS AKIAIOSFODNN7EXAMPLE secret')).toThrow();
  });
});

describe('MCP team tools', () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await callNativeTool(name, args);
    return { err: r.isError === true, body: r.content[0]!.text };
  };
  it('end to end: register, claim, handoff, context, view', async () => {
    expect((await call('phm_team_register', { agentId: 'grok-bot/mason', provider: 'grok-bot', capabilities: ['email'] })).err).toBe(false);
    expect((await call('phm_team_register', { agentId: 'codex/acct-2', provider: 'codex' })).err).toBe(false);
    expect(JSON.parse((await call('phm_team_claim', { agentId: 'codex/acct-2', repo: 'ashlrai/phantom', branch: 'teams' })).body).ok).toBe(true);
    expect(JSON.parse((await call('phm_team_claim', { agentId: 'grok-bot/mason', repo: 'ashlrai/phantom' })).body).ok).toBe(false);
    const h = JSON.parse((await call('phm_team_handoff', { agentId: 'grok-bot/mason', to: 'agent:codex/acct-2', title: 'Write tests' })).body);
    expect((await call('phm_team_handoff', { agentId: 'codex/acct-2', op: 'accept', handoffId: h.handoffId })).err).toBe(false);
    const rel = JSON.parse((await call('phm_team_handoff', { agentId: 'codex/acct-2', title: 'Ship', action: 'release' })).body);
    expect(rel.state).toBe('awaiting-approval');
    expect((await call('phm_team_context_add', { agentId: 'grok-bot/mason', title: 'Bus', text: 'The team bus is an append-only log.', source: 'docs/architecture/teams.md', owner: 'company' })).err).toBe(false);
    expect(JSON.parse((await call('phm_team_context_get', { query: 'bus log', owner: 'company' })).body).items).toHaveLength(1);
    const view = JSON.parse((await call('phm_team_view', {})).body);
    expect(view.members).toHaveLength(2);
    expect(view.claims).toHaveLength(1);
    expect(view.approvals[0].state).toBe('pending');
    expect((await call('phm_team_publish', { agentId: 'bad id with spaces', text: 'x' })).err).toBe(true);
  });
});

describe('phm team CLI', () => {
  it('join, claim conflict, approve', async () => {
    const { cmdTeam } = await import('../src/cli/team.js');
    const log = console.log; const err = console.error; console.log = () => {}; console.error = () => {};
    try {
      expect(await cmdTeam(['join', '--as', 'mason'])).toBe(0);
      expect(await cmdTeam(['claim', 'ashlrai/phantom', '--branch', 'x', '--as', 'mason'])).toBe(0);
      expect(await cmdTeam(['claim', 'ashlrai/phantom', '--as', 'evan'])).toBe(1);
      const h = requestHandoff('default', codex, { title: 'deploy site', action: 'deploy' }) as { approvalId: string };
      expect(await cmdTeam(['approve', h.approvalId, '--as', 'mason'])).toBe(0);
      expect(teamState('default').approvals[0]!.state).toBe('approved');
      expect(await cmdTeam(['bogus'])).toBe(2);
    } finally { console.log = log; console.error = err; }
  });
});
