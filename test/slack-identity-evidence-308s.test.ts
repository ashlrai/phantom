/**
 * RQ-PHX-SLACKIDENTITYEVIDENCE308S -- executable evidence for the EXISTING
 * Slack bridge authenticated-identity boundary (Mason/Dot Nov 13 orders:
 * qualify the boundary; do not invent another bridge; do not treat ready
 * offline configuration as live).
 *
 * Exercises verifySlackIdentity (src/core/agents/slack-transport.ts) through
 * the real SlackCall contract with an injected fake -- synthetic ids only,
 * no token values, no HTTP, no socket, no bus append, no host state. The
 * same gate fronts `phm channels slack probe|run`
 * (src/cli/channels-slack.ts), openSlackSocket and deliverSlackEnvelope.
 *
 * What a resolved verification proves: auth.test authenticated as exactly
 * the configured team_id + own_user_id + own_bot_id. It is identity proof
 * only -- not a fleet claim, not runtime execution, not assignment, and not
 * evidence about the live host (BRIDGE_NOTES.md records the sanitized host
 * as-of read and marks live identity/claims unknown unless independently
 * observed).
 *
 * Pre-existing equivalent coverage, preserved rather than duplicated:
 * test/slack-transport.test.ts ('rejects wrong workspace and bot identities
 * before any socket or post') already asserts a wrong team_id through
 * verifySlackIdentity + deliverSlackEnvelope, and test/slack-leader.test.ts
 * asserts a wrong team through deliverSlackLeaderMessage -> 'drafted'. The
 * matrix below re-asserts the wrong-team row inside this boundary suite for
 * a self-contained read and adds the missing evidence: all-match success,
 * wrong user/bot, absent configured or returned identity fields, rejected
 * auth.test, and the socket/delivery side-effect boundary.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deliverSlackEnvelope, openSlackSocket, verifySlackIdentity,
  type SlackCall, type SlackSocketSession,
} from '../src/core/agents/slack-transport.js';
import type { SlackBridgeConfig } from '../src/core/agents/slack-network.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const TEAM = 'T0IDTEAM';
const USER = 'U0IDBOT';
const BOT = 'B0IDBOT';
const HUMAN = 'U0IDHUMAN';
const CHANNEL = 'D0IDLEADER';

const config: SlackBridgeConfig = {
  bridgeId: 'slack',
  teamId: TEAM,
  ownUserId: USER,
  ownBotId: BOT,
  botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN',
  appTokenRef: 'phm_SLACK_AGENTNET_APP_TOKEN',
  map: [{ topic: 'leader', channel: CHANNEL }],
};
const team = [{ channel: 'slack' as const, id: HUMAN }];
const identity = { ok: true, team_id: TEAM, user_id: USER, bot_id: BOT };
const envelope: BusEnvelope = {
  id: 'rq-slack-identity-308s', from: 'phantom:leader', to: 'leader',
  ttl: 60_000, priority: 'P1',
  body: { kind: 'note', text: 'Synthetic identity-boundary evidence; no real content.' },
};

const roots: string[] = [];
const tmpRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-identity-308s-'));
  roots.push(dir);
  return dir;
};
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

/** Slack methods the injected call actually saw, in order. */
const methods = (call: SlackCall): unknown[] => vi.mocked(call).mock.calls.map(row => row[0]);

/** auth.test replies `auth()`; every other method is served only far enough for the post-identity paths. */
function fakeCall(auth?: () => Record<string, unknown>): SlackCall {
  return vi.fn(async (method: string, input: Record<string, unknown> = {}) => {
    if (method === 'auth.test') return auth ? auth() : identity;
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: input.channel, is_im: true, context_team_id: TEAM } };
    if (method === 'conversations.members') return { members: [USER, HUMAN], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: input.user, team_id: TEAM, ...(input.user === USER ? { is_bot: true } : {}) } };
    if (method === 'chat.postMessage') return { channel: input.channel, ts: '1793920000.000001' };
    if (method === 'conversations.history' || method === 'conversations.replies') return { messages: [] };
    throw new Error(`unexpected-method:${method}`);
  });
}

function configWithout(...drop: Array<'ownUserId' | 'ownBotId'>): SlackBridgeConfig {
  const copy: SlackBridgeConfig = { ...config };
  for (const key of drop) delete copy[key];
  return copy;
}

describe('slack authenticated identity evidence 308s', () => {
  it('verifies only the fully matching configured team, user and bot identity', async () => {
    const call = fakeCall();
    await expect(verifySlackIdentity(call, config)).resolves.toBeUndefined();
    // Identity proof is exactly one auth.test -- no post, socket-open, member
    // or history call is reachable inside verification.
    expect(methods(call)).toEqual(['auth.test']);
  });

  it.each([
    { label: 'auth.test reports a different team_id', cfg: config, auth: { ...identity, team_id: 'T0OTHER' } },
    { label: 'auth.test reports a different user_id', cfg: config, auth: { ...identity, user_id: 'U0OTHER' } },
    { label: 'auth.test reports a different bot_id', cfg: config, auth: { ...identity, bot_id: 'B0OTHER' } },
    { label: 'auth.test omits team_id', cfg: config, auth: { ok: true, user_id: USER, bot_id: BOT } },
    { label: 'auth.test omits user_id', cfg: config, auth: { ok: true, team_id: TEAM, bot_id: BOT } },
    { label: 'auth.test omits bot_id', cfg: config, auth: { ok: true, team_id: TEAM, user_id: USER } },
    { label: 'config has no own_user_id', cfg: configWithout('ownUserId'), auth: identity },
    { label: 'config has no own_bot_id', cfg: configWithout('ownBotId'), auth: identity },
    { label: 'config has neither own id', cfg: configWithout('ownUserId', 'ownBotId'), auth: identity },
    { label: 'config and auth.test both omit the self ids', cfg: configWithout('ownUserId', 'ownBotId'), auth: { ok: true, team_id: TEAM } },
  ])('refuses with slack-identity-mismatch when $label', async ({ cfg, auth }) => {
    const call = fakeCall(() => auth);
    await expect(verifySlackIdentity(call, cfg)).rejects.toThrow('slack-identity-mismatch');
    expect(methods(call)).toEqual(['auth.test']);
  });

  it('propagates an auth.test refusal unchanged instead of masking it as a mismatch', async () => {
    const refusal = new Error('slack-api-refused');
    const call = fakeCall(() => { throw refusal; });
    const failure = await verifySlackIdentity(call, config).then(() => null, (error: unknown) => error);
    expect(failure).toBe(refusal);
    expect(methods(call)).toEqual(['auth.test']);
  });

  it.each([
    { label: 'team', auth: { ...identity, team_id: 'T0OTHER' } },
    { label: 'user', auth: { ...identity, user_id: 'U0OTHER' } },
    { label: 'bot', auth: { ...identity, bot_id: 'B0OTHER' } },
  ])('opens no socket when auth.test reports a different $label', async ({ auth }) => {
    const call = fakeCall(() => auth);
    const connect = vi.fn((_url: string): SlackSocketSession => { throw new Error('socket-opened-despite-mismatch'); });
    // verifySlackIdentity runs before apps.connections.open and connect, so a
    // mismatch can never produce a socket that would enqueue or claim events.
    await expect(openSlackSocket({ call, config, ingest: { config, teamIdentities: team }, connect }))
      .rejects.toThrow('slack-identity-mismatch');
    expect(connect).not.toHaveBeenCalled();
    expect(methods(call)).toEqual(['auth.test']);
  });

  it('posts nothing and persists no delivery claim when identity mismatches, then delivers once verified', async () => {
    const stateRoot = tmpRoot();
    const input = { config, teamIdentities: team, confirmedByMason: true, stateRoot };
    // A wrong user_id through the real delivery entry point -- the existing
    // suite covers the wrong-team row; this adds a second mismatch kind.
    const mismatched = fakeCall(() => ({ ...identity, user_id: 'U0OTHER' }));
    await expect(deliverSlackEnvelope(envelope, { ...input, call: mismatched }))
      .resolves.toMatchObject({ status: 'uncertain' });
    expect(methods(mismatched)).toEqual(['auth.test']);
    // No attempted/sent receipt was ever written: the failed check held no claim.
    expect(existsSync(join(stateRoot, 'messages.json'))).toBe(false);

    // The same envelope verifies and delivers exactly once -- proof the failed
    // identity check neither posted nor wedged the delivery lock.
    const verified = fakeCall();
    await expect(deliverSlackEnvelope(envelope, { ...input, call: verified }))
      .resolves.toMatchObject({ status: 'sent' });
    expect(vi.mocked(verified).mock.calls.filter(row => row[0] === 'chat.postMessage')).toHaveLength(1);
  });
});
