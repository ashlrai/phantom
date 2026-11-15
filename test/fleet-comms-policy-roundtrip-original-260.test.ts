/**
 * RQ-PHX-COMMSPOLICYORIGINAL260S — HTTP round-trip preservation proof for the
 * original send-policy status block (RQ-PHX-COMMSPOLICYSTATE18, original
 * commit a65613de). One handler instance serves three phases through the real
 * request/response path while a mutable trusted sendPolicy reader changes
 * underneath it: confirmed authority, a thrown reader, then a recovered
 * policy. Each request must re-read state — a failure yields null/degraded
 * instead of replaying confirmed authority, unrelated sections stay live, and
 * recovery reports the current deduplicated sorted channels/counts. The
 * serialized wire text never exposes fake identity strings, filesystem paths
 * or thrown error text.
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

const FIXED_NOW = new Date('2026-11-13T20:00:00.000Z');
const FIXED_ISO = FIXED_NOW.toISOString();

type Policy = { teamIdentities: { channel: ChannelId; id: string }[]; confirmedByMason: boolean };

const CONFIRMED_A: Policy = {
  teamIdentities: [
    { channel: 'slack', id: 'fake-260-identity-A' },
    { channel: 'imessage', id: 'fake-260-identity-B' },
    { channel: 'slack', id: 'fake-260-identity-C' },
  ],
  confirmedByMason: true,
};

const RECOVERED: Policy = {
  teamIdentities: [
    { channel: 'email', id: 'fake-260-identity-D' },
    { channel: 'telegram', id: 'fake-260-identity-E' },
    { channel: 'email', id: 'fake-260-identity-F' },
    { channel: 'slack', id: 'fake-260-identity-G' },
  ],
  confirmedByMason: true,
};

const THROWN_TEXT = 'open /private/fake-260-home/.ashlr/comms.toml: EPERM';

const finding = (state: string) => ({ state, reason: `T260_${state.toUpperCase()}`, nextStep: 'none' });
const capability = (state: 'ready' | 'blocked' | 'unsupported' | 'unverified') =>
  ({ state, reason: `T260_${state.toUpperCase()}`, nextStep: 'none' });

async function request(api: ApiModule, method = 'GET') {
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
    method,
  );
  return { handled, code, text, body: text.length > 0 ? JSON.parse(text) : null };
}

async function makeApi() {
  const runsDir = await mkdtemp(join(tmpdir(), 'comms-policy-260-'));
  let reads = 0;
  const state: { read: () => Policy } = { read: () => CONFIRMED_A };
  const api = createFleetCommsStatusApi({
    runsDir,
    now: () => new Date(FIXED_NOW.getTime()),
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
  return { api, state, readCount: () => reads };
}

describe('createFleetCommsStatusApi send-policy round-trip (original 260)', () => {
  it('re-reads policy per request: confirmed → thrown reader → recovered', async () => {
    const { api, state, readCount } = await makeApi();

    // Phase A — confirmed authority.
    const a = await request(api);
    expect(a.handled).toBe(true);
    expect(a.code).toBe(200);
    expect(a.body.version).toBe(1);
    expect(a.body.generatedAt).toBe(FIXED_ISO);
    expect(a.body.sendPolicy).toEqual({ confirmed: true, teamIdentities: 3, channels: ['imessage', 'slack'] });
    expect(a.body.sources.sendPolicy).toBe('healthy');
    expect(readCount()).toBe(1);
    expect(a.text).not.toContain('fake-260-identity');
    expect(a.text).not.toContain(homedir());
    expect(a.text).not.toContain('.ashlr/');

    // Phase B — the reader throws: degraded, never a replay of phase A.
    state.read = () => { throw new Error(THROWN_TEXT); };
    const b = await request(api);
    expect(b.code).toBe(200);
    expect(b.body.sendPolicy).toBeNull();
    expect(b.body.sources.sendPolicy).toBe('degraded');
    expect(readCount()).toBe(2);
    // Unrelated sections stay live through the same instance.
    expect(b.body.drafts).toEqual({ pending: 0, oldestPendingAt: null });
    expect(b.body.sources.drafts).toBe('healthy');
    expect(b.body.emailOutbox?.configured).toBe(false);
    expect(b.body.imessage?.configuration.state).toBe('configured');
    expect(b.body.sources.imessage).toBe('healthy');
    expect(b.body.imessage?.acks24h).toBe(1);
    expect(b.body.teammate?.texts).toBe(4);
    expect(b.body.sources.teammate).toBe('healthy');
    expect(b.body.cutover?.overall.state).toBe('incomplete');
    expect(b.body.sources.cutover).toBe('healthy');
    // Serialized wire text carries no identities, paths or thrown error text.
    expect(b.text).not.toContain('fake-260-identity');
    expect(b.text).not.toContain('fake-260-home');
    expect(b.text).not.toContain('EPERM');
    expect(b.text).not.toContain(THROWN_TEXT);
    expect(b.text).not.toContain(homedir());
    expect(b.text).not.toContain('.ashlr/');

    // Phase C — recovery reports the current policy, not a phase-A replay.
    state.read = () => RECOVERED;
    const c = await request(api);
    expect(c.code).toBe(200);
    expect(c.body.sendPolicy).toEqual({ confirmed: true, teamIdentities: 4, channels: ['email', 'slack', 'telegram'] });
    expect(c.body.sources.sendPolicy).toBe('healthy');
    expect(c.body.generatedAt).toBe(FIXED_ISO);
    expect(readCount()).toBe(3);
    expect(c.text).not.toContain('fake-260-identity');
    expect(c.text).not.toContain(homedir());
  });

  it('still refuses non-GET methods through the same instance', async () => {
    const { api, readCount } = await makeApi();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await request(api, method);
      expect(r.handled).toBe(true);
      expect(r.code).toBe(405);
      expect(r.body.error).toBe('method not allowed');
    }
    // Refused methods never touch the policy reader.
    expect(readCount()).toBe(0);
  });
});
