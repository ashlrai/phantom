import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setApprovalPresencePublicKeyForTest, invitePresenceBytes } from '../src/core/approvals/actor.js';
import { appendEvent, readEvents } from '../src/core/teams/store.js';
import { teamState } from '../src/core/teams/state.js';
import { acceptTeamInvite, createTeamInvite, DEFAULT_INVITE_TTL_MS } from '../src/core/teams/invites.js';
import { handleApi } from '../src/core/web/api.js';
import { defaultConfig } from '../src/core/config.js';
import type { TeamActor } from '../src/core/teams/protocol.js';

const identity = vi.hoisted(() => ({ id: 'human:owner' }));
vi.mock('../src/core/teams/identity.js', () => ({
  localHumanActor: () => ({ kind: 'human', id: identity.id }),
  enrolledHumanActor: () => ({ kind: 'human', id: identity.id }),
  assertLocalHuman: (actor: TeamActor) => { if (actor.kind !== 'human' || actor.id !== identity.id) throw new Error('Wrong local identity'); },
}));
const owner: TeamActor = { kind: 'human', id: 'human:owner' };
const member: TeamActor = { kind: 'human', id: 'human:member' };
const team = 'invite-test';
const tokenOf = (link: string) => new URLSearchParams(link.split('?')[1]).get('invite')!;
let counter = 0;
let currentTeam: string;
let signInvite: (teamId: string, op: 'create' | 'accept') => string = () => '';
beforeEach(() => {
  identity.id = owner.id;
  currentTeam = `${team}-${counter++}`;
  appendEvent(currentTeam, owner, 'member.joined', {});
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  _setApprovalPresencePublicKeyForTest(typeof pem === 'string' ? pem : pem.toString());
  signInvite = (teamId, op) => signBytes('sha256', invitePresenceBytes(teamId, op), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
});
afterEach(() => { _setApprovalPresencePublicKeyForTest(null); });
function issue(ttl?: number) { return createTeamInvite(currentTeam, owner, ttl); }
function redeem(link: string, target = currentTeam) { identity.id = member.id; return acceptTeamInvite(target, tokenOf(link), member); }

async function request(body: unknown, options: { token?: string; allowDispatch?: boolean; method?: string; contentType?: string; accept?: boolean } = {}) {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.url = `/api/teams/${currentTeam}/invites${options.accept ? '/accept' : ''}`;
  req.method = options.method ?? 'POST';
  req.headers = { 'x-ashlr-token': options.token ?? 'test-mutation', 'content-type': options.contentType ?? 'application/json' };
  let status = 0; let result = '';
  const res = { setHeader: vi.fn(), writeHead: (code: number) => { status = code; }, end: (text: string) => { result = text; } } as unknown as ServerResponse;
  await handleApi(req, res, defaultConfig(), { token: 'test-mutation', allowDispatch: options.allowDispatch ?? true });
  return { status, body: JSON.parse(result) as Record<string, unknown> };
}

describe('single-use team invitations', () => {
  it('defaults to seven days, persists only a digest, and grants member role', () => {
    const start = Date.now(); const invite = issue();
    expect(invite.expiresAt).toBeGreaterThanOrEqual(start + 7 * 24 * 60 * 60_000);
    expect(invite.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60_000);
    expect(JSON.stringify(readEvents(currentTeam))).not.toContain(tokenOf(invite.link));
    expect(redeem(invite.link)).toEqual({ team: currentTeam, memberId: member.id });
    expect(teamState(currentTeam).members.find(m => m.id === member.id)?.role).toBe('member');
  });
  it('rejects reuse, including a second identity', () => {
    const invite = issue(); redeem(invite.link); identity.id = 'human:other';
    expect(() => acceptTeamInvite(currentTeam, tokenOf(invite.link), { kind: 'human', id: identity.id })).toThrow(/already been used/);
  });
  it('rejects expiry at the exact boundary without consuming the link', () => {
    const invite = issue(1000); const now = vi.spyOn(Date, 'now').mockReturnValue(invite.expiresAt);
    try { expect(() => redeem(invite.link)).toThrow(/expired/); }
    finally { now.mockRestore(); }
    expect(readEvents(currentTeam).filter(e => e.payload.inviteDigest)).toHaveLength(0);
  });
  it('rejects a wrong team without consuming the valid invitation', () => {
    const invite = issue(); expect(() => redeem(invite.link, 'wrong-team')).toThrow(/invalid/);
    expect(redeem(invite.link).team).toBe(currentTeam);
  });
  it('rejects unknown tokens, spoofed identities, non-admin issuance and invalid TTLs', () => {
    expect(() => createTeamInvite(currentTeam, member)).toThrow(/identity/);
    for (const ttl of [0, -1, NaN, Infinity, 1.2, DEFAULT_INVITE_TTL_MS + 1]) expect(() => issue(ttl)).toThrow(/Expiry/);
    appendEvent(currentTeam, member, 'member.joined', {}); identity.id = member.id;
    expect(() => createTeamInvite(currentTeam, member)).toThrow(/owners/);
    expect(() => acceptTeamInvite(currentTeam, '0'.repeat(64), member)).toThrow(/invalid/);
  });
  it('enforces dispatch, token, JSON and method gates before mutations', async () => {
    expect((await request({}, { allowDispatch: false })).status).toBe(404);
    expect((await request({}, { token: 'wrong' })).status).toBe(401);
    expect((await request({}, { contentType: 'text/plain' })).status).toBe(415);
    expect((await request({}, { method: 'GET' })).status).toBe(405);
    expect((await request({ actor: member })).status).toBe(400);
    expect(readEvents(currentTeam)).toHaveLength(1);
  });
  it('refuses a token alone and a forged actor, and accepts a presence assertion', async () => {
    const bare = await request({});
    expect(bare.status).toBe(403);
    expect(bare.body.code).toBe('human-presence-required');
    expect(readEvents(currentTeam)).toHaveLength(1);
    const created = await request({ assertion: signInvite(currentTeam, 'create') });
    expect(created.status).toBe(201);
    const token = tokenOf(created.body.link as string);
    const other = currentTeam;
    currentTeam = `${currentTeam}-other`;
    appendEvent(currentTeam, owner, 'member.joined', {});
    identity.id = member.id;
    expect((await request({ token, assertion: signInvite(currentTeam, 'accept') }, { accept: true })).status).toBe(409);
    expect((await request({ token, assertion: signInvite(other, 'create') }, { accept: true })).status).toBe(403);
    currentTeam = other;
    expect((await request({ token: 'f'.repeat(64), assertion: signInvite(currentTeam, 'accept') }, { accept: true })).status).toBe(409);
    expect((await request({ token }, { accept: true })).status).toBe(403);
    identity.id = member.id;
    expect((await request({ token, assertion: signInvite(currentTeam, 'accept') }, { accept: true })).status).toBe(200);
    expect((await request({ token, assertion: signInvite(currentTeam, 'accept') }, { accept: true })).status).toBe(409);
  });
});
