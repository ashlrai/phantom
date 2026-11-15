/**
 * RQ-PHX-POLICYOWNERQUALIFY287S — qualification companion to owner PR #5350
 * (RQ-PHX-COMMSPOLICYORIGINAL260S, head 00a3161b). The owner's round-trip proof
 * covers confirmed → throwing reader → recovered on one handler instance, but
 * never serves a *valid unconfirmed* policy (confirmedByMason:false) between two
 * confirmed reads. This test closes that gap through the same real ApiModule
 * boundary: one handler instance, an advancing injected clock, and a mutable
 * trusted sendPolicy reader. The middle response must report confirmed:false
 * with the unconfirmed fixture's own sanitized counts/channels — never a replay
 * of the earlier confirmed:true authority — while sources.sendPolicy stays
 * 'healthy' because the reader succeeded (unconfirmed is not degraded). A second
 * case covers the zero-identity unconfirmed shape that readLocalSendPolicy
 * itself declares ({ teamIdentities: [], confirmedByMason: false }). Serialized
 * wire text never exposes fake identity strings, filesystem paths or home dirs.
 * Status-only proof: nothing here asserts transport delivery or Slack dispatch.
 */
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createFleetCommsStatusApi, VERSE_FLEET_COMMS_STATUS_PATH } from '../src/core/verse/fleet-comms-status-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { ChannelId } from '../src/core/agents/channel-policy.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const BASE_NOW = new Date('2026-11-13T20:00:00.000Z');
const STEP_MS = 60_000;

type Policy = { teamIdentities: { channel: ChannelId; id: string }[]; confirmedByMason: boolean };

const CONFIRMED_A: Policy = {
  teamIdentities: [
    { channel: 'slack', id: 'fake-287-identity-A' },
    { channel: 'imessage', id: 'fake-287-identity-B' },
    { channel: 'slack', id: 'fake-287-identity-C' },
  ],
  confirmedByMason: true,
};

const UNCONFIRMED_B: Policy = {
  teamIdentities: [
    { channel: 'email', id: 'fake-287-identity-D' },
    { channel: 'telegram', id: 'fake-287-identity-E' },
  ],
  confirmedByMason: false,
};

const RECOVERED_C: Policy = {
  teamIdentities: [
    { channel: 'slack', id: 'fake-287-identity-F' },
    { channel: 'email', id: 'fake-287-identity-G' },
    { channel: 'telegram', id: 'fake-287-identity-H' },
    { channel: 'imessage', id: 'fake-287-identity-I' },
  ],
  confirmedByMason: true,
};

const EMPTY_UNCONFIRMED: Policy = { teamIdentities: [], confirmedByMason: false };

const isoAt = (tick: number): string => new Date(BASE_NOW.getTime() + tick * STEP_MS).toISOString();

const finding = (state: string) => ({ state, reason: `T287_${state.toUpperCase()}`, nextStep: 'none' });
const capability = (state: 'ready' | 'blocked' | 'unsupported' | 'unverified') =>
  ({ state, reason: `T287_${state.toUpperCase()}`, nextStep: 'none' });

async function request(api: ApiModule) {
  let text = '';
  let code = 0;
  const res = {
    writeHead(c: number) { code = c; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const handled = await api(
    { cfg: {}, allowDispatch: true } as VerseApiContext,
    new PassThrough() as IncomingMessage,
    res,
    VERSE_FLEET_COMMS_STATUS_PATH,
    'GET',
  );
  return { handled, code, text, body: text.length > 0 ? JSON.parse(text) : null };
}

async function makeApi() {
  const runsDir = await mkdtemp(join(tmpdir(), 'comms-policy-287-'));
  let reads = 0;
  let tick = 0;
  const state: { read: () => Policy } = { read: () => CONFIRMED_A };
  const api = createFleetCommsStatusApi({
    runsDir,
    now: () => new Date(BASE_NOW.getTime() + tick * STEP_MS),
    sendPolicy: () => {
      reads += 1;
      return state.read();
    },
    // Hermetic seams: the default iMessage probe would touch the real host.
    imessagePath: () => ({
      schema: 'fleet.imessage-path.v1',
      platform: finding('unsupported'),
      configuration: finding('configured'),
      chatDb: finding('readable'),
      cursor: finding('present'),
      transport: finding('owner_only'),
      ownerReply: finding('unknown'),
      collaboratorIntake: finding('unsupported'),
      collaboratorDelivery: finding('unsupported'),
    }),
    imessageAcks: async () => ({
      sourceState: 'ok' as const,
      rows: [{ timestamp: '2026-11-13T19:00:00.000Z', rowid: 41, status: 'accepted' as const, delivery: 'recorded-not-sent' as const }],
      malformedRows: 0,
      deliveryProof: false as const,
    }),
    teammateLatency: () => ({
      v: 1 as const, windowHours: 24, targetMinutes: 60, texts: 4, answered: 3, unanswered: 1, ignorable: 0,
      medianMinutes: 9, p90Minutes: 30, maxMinutes: 41, withinTarget: 3,
      oldestUnanswered: { rowid: 7, ageMinutes: 55, intent: 'reply' as const },
      latestTextAt: '2026-11-13T19:30:00.000Z', sourceState: 'healthy' as const,
    }),
    cutover: async () => ({
      schema: 'fleet.comms-cutover-readiness.v1' as const,
      coverage: 'local-evidence-only-not-delivery-proof' as const,
      capabilities: {
        emailPolling: capability('ready'), emailOutbox: capability('ready'),
        ownerImessageIntake: capability('ready'), ownerImessageDelivery: capability('blocked'),
        teammateImessageIntake: capability('unverified'), teammateImessageDelivery: capability('unsupported'),
        gmailInboxTriage: capability('ready'), linkedin: capability('unverified'),
      },
      overall: { state: 'incomplete' as const, blockers: ['ownerImessageDelivery'], commsbotRetirement: 'not-evidenced' as const, nextStep: 'none' },
    }),
  });
  return {
    api, state, runsDir,
    readCount: () => reads,
    advance: () => { tick += 1; },
  };
}

describe('createFleetCommsStatusApi send-policy unconfirmed round-trip (owner qualify 287)', () => {
  it('confirmed → valid unconfirmed → recovered on one instance never replays confirmed authority', async () => {
    const { api, state, runsDir, readCount, advance } = await makeApi();

    // Phase A — confirmed authority at t0.
    const a = await request(api);
    expect(a.handled).toBe(true);
    expect(a.code).toBe(200);
    expect(a.body.sendPolicy).toEqual({ confirmed: true, teamIdentities: 3, channels: ['imessage', 'slack'] });
    expect(a.body.sources.sendPolicy).toBe('healthy');
    expect(a.body.generatedAt).toBe(isoAt(0));
    expect(readCount()).toBe(1);

    // Phase B — a *valid* unconfirmed policy at t1: the reader succeeds, so the
    // source stays healthy, but confirmed must be false with B's own counts and
    // channels — never a replay of phase A's confirmed:true authority.
    state.read = () => UNCONFIRMED_B;
    advance();
    const b = await request(api);
    expect(b.code).toBe(200);
    expect(b.body.sendPolicy).toEqual({ confirmed: false, teamIdentities: 2, channels: ['email', 'telegram'] });
    expect(b.body.sendPolicy.confirmed).not.toBe(a.body.sendPolicy.confirmed);
    expect(b.body.sources.sendPolicy).toBe('healthy');
    expect(b.body.generatedAt).toBe(isoAt(1));
    expect(readCount()).toBe(2);
    // Unrelated sections stay live through the same instance.
    expect(b.body.drafts).toEqual({ pending: 0, oldestPendingAt: null });
    expect(b.body.sources.drafts).toBe('healthy');
    expect(b.body.imessage?.configuration.state).toBe('configured');
    expect(b.body.teammate?.texts).toBe(4);
    expect(b.body.cutover?.overall.state).toBe('incomplete');
    // Serialized wire text carries no identities or local paths.
    expect(b.text).not.toContain('fake-287-identity');
    expect(b.text).not.toContain(homedir());
    expect(b.text).not.toContain(runsDir);
    expect(b.text).not.toContain('.ashlr/');

    // Phase C — recovery at t2 reports the current confirmed policy, fresh stamp.
    state.read = () => RECOVERED_C;
    advance();
    const c = await request(api);
    expect(c.code).toBe(200);
    expect(c.body.sendPolicy).toEqual({ confirmed: true, teamIdentities: 4, channels: ['email', 'imessage', 'slack', 'telegram'] });
    expect(c.body.sources.sendPolicy).toBe('healthy');
    expect(c.body.generatedAt).toBe(isoAt(2));
    expect(readCount()).toBe(3);
    expect(c.text).not.toContain('fake-287-identity');
    expect(c.text).not.toContain(homedir());
    expect(c.text).not.toContain(runsDir);
  });

  it('reports the declared zero-identity unconfirmed shape without replaying prior authority', async () => {
    const { api, state, readCount, advance } = await makeApi();

    const a = await request(api);
    expect(a.body.sendPolicy.confirmed).toBe(true);

    // readLocalSendPolicy's own no-home return is { [], false }: a valid,
    // readable policy with zero identities must surface as confirmed:false,
    // teamIdentities:0, channels:[] — still healthy, never degraded.
    state.read = () => EMPTY_UNCONFIRMED;
    advance();
    const b = await request(api);
    expect(b.code).toBe(200);
    expect(b.body.sendPolicy).toEqual({ confirmed: false, teamIdentities: 0, channels: [] });
    expect(b.body.sources.sendPolicy).toBe('healthy');
    expect(b.body.generatedAt).toBe(isoAt(1));
    expect(readCount()).toBe(2);
    expect(b.text).not.toContain('fake-287-identity');
    expect(b.text).not.toContain(homedir());
    expect(b.text).not.toContain('.ashlr/');
  });
});
