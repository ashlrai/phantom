import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createTeamApi, type TeamApiDeps } from '../src/core/verse/team-api.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';
import { AGENT_ENV_MARKERS, ownerConfigPath } from '../src/core/teams/identity.js';
import { inviteMember } from '../src/core/teams/membership.js';
import { appendEvent, requestHandoff, type TeamActor } from '../src/core/teams/index.js';

const TOKEN = 'team-api-test-token';
const BASE = '/api/verse/team';
const INVITE = '/api/verse/team/invite';
const T = 'team-api-17';
const owner: TeamActor = { kind: 'human', id: 'human:fake-owner' };
const octo: TeamActor = { kind: 'human', id: 'human:octocat' };
let home = '';

async function call(api: ReturnType<typeof createTeamApi>, o: { path: string; method?: string; body?: unknown; token?: string | null; allowDispatch?: boolean }) {
  const method = o.method ?? 'POST';
  const req = Readable.from(method === 'GET' ? [] : [JSON.stringify(o.body ?? {})]) as unknown as IncomingMessage;
  req.url = o.path;
  req.method = method;
  req.headers = { 'content-type': 'application/json', ...(o.token === null ? {} : { 'x-ashlr-token': o.token ?? TOKEN }) };
  let status = 0;
  let raw = '';
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    setHeader() {},
    end(text: string) { raw = text ?? ''; },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: o.allowDispatch ?? true } as VerseApiContext;
  const handled = await api(ctx, req, res, o.path.split('?')[0]!, method);
  let wire: Record<string, any> | null = null;
  try { wire = JSON.parse(raw); } catch { /* empty body */ }
  return { handled, status, raw, wire };
}
const make = (deps: TeamApiDeps = {}) => createTeamApi({ actor: () => owner, ...deps });

const asHuman = (name: string) => {
  mkdirSync(dirname(ownerConfigPath()), { recursive: true });
  writeFileSync(ownerConfigPath(), JSON.stringify({ human: name }));
};
const ownerJoined = () => { asHuman('fake-owner'); appendEvent(T, owner, 'member.joined', {}); };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'team-api-17-'));
  vi.stubEnv('ASHLR_HOME', home);
  for (const marker of AGENT_ENV_MARKERS) vi.stubEnv(marker, '');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('verse team api', () => {
  it('is registered in the workbench family table', () => {
    expect(workbenchFamilyFor(BASE)?.id).toBe('team');
    expect(workbenchFamilyFor(INVITE)?.id).toBe('team');
  });

  it('GET an empty team lists no members and points at phm team join', async () => {
    const r = await call(make(), { path: BASE, method: 'GET' });
    expect(r.status).toBe(200);
    expect(r.wire).toMatchObject({ v: 1, team: 'default', members: [], repos: [], claims: [], openHandoffs: [], pendingApprovals: [] });
    expect(r.wire?.next).toContain('phm team join');
  });

  it('GET after an owner joins and invites octocat lists both with roles, and blanks a private path', async () => {
    ownerJoined();
    inviteMember(T, owner, 'octocat');
    appendEvent(T, owner, 'presence.heartbeat', { status: 'reviewing' });
    appendEvent(T, owner, 'message.posted', { channel: 'general', text: 'log at /Users/someone/x' });
    requestHandoff(T, owner, { title: 'pick a task' });
    const r = await call(make(), { path: `${BASE}?team=${T}`, method: 'GET' });
    expect(r.status).toBe(200);
    expect(Object.keys(r.wire!).sort()).toEqual(['claims', 'members', 'messages', 'next', 'openHandoffs', 'pendingApprovals', 'repos', 'team', 'v']);
    const members = r.wire!.members.map((m: { id: string; role: string }) => `${m.id}:${m.role}`).sort();
    expect(members).toEqual(['human:fake-owner:owner', 'human:octocat:member']);
    expect(r.wire!.members.find((m: { id: string }) => m.id === owner.id)).toMatchObject({ kind: 'human', status: 'reviewing' });
    expect(r.wire!.messages.at(-1).text).toBe('');
    expect(r.wire!.openHandoffs).toEqual([{ id: expect.any(String), title: 'pick a task', state: 'open', from: owner.id, assignee: '' }]);
    expect(r.wire!.next).toBe('Confirm your role and task with the owner.');
  });

  it('GET with a traversal team id is 400, a foreign path is not claimed', async () => {
    const api = make();
    const bad = await call(api, { path: `${BASE}?team=${encodeURIComponent('../etc')}`, method: 'GET' });
    expect(bad.status).toBe(400);
    expect(bad.wire?.code).toBe('VERSE_INVALID');
    expect((await call(api, { path: '/api/verse/team/other', method: 'GET' })).handled).toBe(false);
  });

  it('POST invite with the mutation token returns a membership-only invite', async () => {
    ownerJoined();
    const r = await call(make(), { path: INVITE, body: { team: T, githubUser: 'octocat' } });
    expect(r.status).toBe(201);
    expect(Object.keys(r.wire!).sort()).toEqual(['grants', 'invite', 'member', 'next', 'team', 'v']);
    expect(r.wire).toMatchObject({ v: 1, team: T, member: 'human:octocat', grants: 'membership-only' });
    expect(r.wire?.invite).toMatch(/^phm-invite-v1\./);
  });

  it('refuses a POST without the mutation token', async () => {
    ownerJoined();
    const api = make();
    expect((await call(api, { path: INVITE, body: { team: T, githubUser: 'octocat' }, token: null })).status).toBe(401);
    expect((await call(api, { path: INVITE, body: { team: T, githubUser: 'octocat' }, token: 'wrong' })).status).toBe(401);
  });

  it('rejects extra keys and a bad username without echoing it', async () => {
    ownerJoined();
    const api = make();
    expect((await call(api, { path: INVITE, body: { team: T, githubUser: 'octocat', extra: 'y' } })).status).toBe(400);
    expect((await call(api, { path: INVITE, body: { team: T } })).status).toBe(400);
    const bad = await call(api, { path: INVITE, body: { team: T, githubUser: 'not a user!' } });
    expect(bad.status).toBe(400);
    expect(bad.wire).toEqual({ code: 'VERSE_INVALID', error: 'invalid GitHub username' });
    expect(bad.raw).not.toContain('not a user');
  });

  it('POST as a non-admin actor is 403 TEAM_REFUSED', async () => {
    ownerJoined();
    inviteMember(T, owner, 'octocat');
    asHuman('octocat');
    const r = await call(make({ actor: () => octo }), { path: INVITE, body: { team: T, githubUser: 'someone-else' } });
    expect(r.status).toBe(403);
    expect(r.wire).toEqual({ code: 'TEAM_REFUSED', error: 'Only a team owner or admin can invite.' });
    const stubbed = await call(make({ invite: () => { throw new Error('Workspace changes require a human owner/admin.'); } }), { path: INVITE, body: { team: T, githubUser: 'someone-else' } });
    expect(stubbed.status).toBe(403);
    expect(stubbed.wire?.code).toBe('TEAM_REFUSED');
  });

  it('404s when dispatch is disallowed and 405s wrong methods', async () => {
    const api = make();
    expect((await call(api, { path: BASE, method: 'GET', allowDispatch: false })).status).toBe(404);
    expect((await call(api, { path: INVITE, allowDispatch: false })).status).toBe(404);
    expect((await call(api, { path: BASE })).status).toBe(405);
    expect((await call(api, { path: INVITE, method: 'GET' })).status).toBe(405);
  });

  it('unreadable state is 503, and the remote gateway never carries an invite', async () => {
    const api = make({ readTeam: () => { throw new Error('io'); } });
    expect((await call(api, { path: BASE, method: 'GET' })).wire?.code).toBe('TEAM_UNAVAILABLE');
    expect(classifyRemoteRoute('POST', INVITE)).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('GET', BASE)).toEqual({ kind: 'deny' });
  });
});
