import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetClaimNotices } from '../src/cli/fleet-claim-notices.js';
import type { AgentNetworkConfig } from '../src/core/agents/slack-network.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const team = 'T000FAKE';
const channel = 'C000FAKE';
const thread = `${team}/${channel}/1700000000.000001`;
const canonicalThread = `slack:${team}:${channel}:1700000000.000001`;
const head = 'abcdef1234567890';
const claim = { id: 'claim-fake-494', repo: 'ashlrai/phantom', task: 'fake task', agent: 'fake-owner',
  claimedAt: now - 1000, expiresAt: now + 3_600_000 };
const key = JSON.stringify(['ASSIGNED', claim.id, head]);
const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims: [claim],
  messages: [], proposals: [], expiredClaims: 0 };
const config = (teamId: string, map: { topic: string; channel: string }[]): AgentNetworkConfig => ({
  path: 'fake-agent-network.toml', state: 'ok', teamIdentities: [],
  slack: { bridgeId: 'slack', teamId, map },
});
interface Envelope {
  id: string; to: string; channel: string; channel_ref: string;
  body: { kind: string; thread: string; inReplyTo: string; text: string };
}

describe('claim notice CLI configuration repair', () => {
  let root: string;
  let runsRoot: string;
  let busRoot: string;
  let prev: string;
  let sent: string;
  let inbox: string;
  let previous: Buffer;
  const rows = (): Envelope[] => existsSync(inbox)
    ? (JSON.parse(readFileSync(inbox, 'utf8')) as { rows: { envelope: Envelope }[] }).rows.map(row => row.envelope)
    : [];
  const run = async (readConfig: () => AgentNetworkConfig) => {
    const code = await cmdFleetClaimNotices(['--json'], {
      runsRoot, busRoot, readBoard: () => board, now: () => now, killed: false, readConfig,
    });
    const output = vi.mocked(console.log).mock.calls.at(-1)?.[0];
    expect(typeof output).toBe('string');
    return { code, report: JSON.parse(String(output)) as {
      status: string; planned: number; sent: number; failed: number; skipped: number;
      notices: { result: string; reason?: string; receipt?: string; dedupeKey: string; threadKey: string }[];
    } };
  };
  const expectPending = (reason: string, result: Awaited<ReturnType<typeof run>>) => {
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ status: 'completed', planned: 1, sent: 0, failed: 1, skipped: 0,
      notices: [{ result: 'failed', reason, dedupeKey: key, threadKey: thread }] });
    expect(result.report.notices[0]?.receipt).toBeUndefined();
    expect(rows()).toEqual([]);
    expect(existsSync(sent)).toBe(false);
    expect(readFileSync(prev)).toEqual(previous);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claim-notice-config-494-'));
    runsRoot = join(root, 'runs');
    busRoot = join(root, 'bus');
    // Both roots are private and independent; the CLI creates the bus files.
    mkdirSync(runsRoot, { mode: 0o700 });
    mkdirSync(busRoot, { mode: 0o700 });
    prev = join(runsRoot, 'claim-notice-prev.json');
    sent = join(runsRoot, 'claim-notice-sent.jsonl');
    inbox = join(busRoot, 'bus-inbox', 'messages.json');
    writeFileSync(join(runsRoot, 'claim-thread-bindings.jsonl'), JSON.stringify({ v: 1,
      claimId: claim.id, repo: claim.repo, threadKey: thread, pr: 123, head }) + '\n', { mode: 0o600 });
    writeFileSync(prev, JSON.stringify({ v: 1, state: 'known', claims: [], messages: [], asOf: now - 60_000 }),
      { mode: 0o600 });
    previous = readFileSync(prev);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('retries the pending assignment once after adding its channel mapping', async () => {
    const unrelated = { topic: 'other.topic', channel: 'C111FAKE' };
    expectPending('unmapped-channel', await run(() => config(team, [unrelated])));

    const repaired = await run(() => config(team, [unrelated, { topic: 'fleet.claims', channel }]));
    expect(repaired.code).toBe(0);
    expect(repaired.report).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0, skipped: 0,
      notices: [{ result: 'sent', dedupeKey: key, threadKey: thread }] });
    const envelopes = rows();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ to: 'fleet.claims', channel: 'slack', channel_ref: thread,
      body: { kind: 'note', thread: canonicalThread, inReplyTo: key } });
    expect(envelopes[0]?.body.text).toContain('ASSIGNED');
    expect(repaired.report.notices[0]?.receipt).toBe(`bus-note:${envelopes[0]?.id}`);
    expect(envelopes[0]?.id).toMatch(/^claim-notice-[0-9a-f]{24}$/);
    const ledger = readFileSync(sent, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { key: string });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.key).toBe(key);
    expect(readFileSync(prev)).not.toEqual(previous);
    expect(JSON.parse(readFileSync(prev, 'utf8'))).toMatchObject({ state: 'known', claims: [claim], asOf: now });

    const again = await run(() => config(team, [unrelated, { topic: 'fleet.claims', channel }]));
    expect(again.code).toBe(0);
    expect(again.report).toMatchObject({ status: 'completed', planned: 0, sent: 0, failed: 0, skipped: 0, notices: [] });
    expect(rows()).toEqual(envelopes);
    expect(readFileSync(sent, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('refuses a matching channel under a different team', async () => {
    expectPending('thread-ref-unusable', await run(() => config('T111FAKE', [
      { topic: 'wrong.team', channel }, { topic: 'other.topic', channel: 'C111FAKE' },
    ])));
  });
});
