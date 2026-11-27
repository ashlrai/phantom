import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetClaimNotices } from '../src/cli/fleet-claim-notices.js';
import type { AgentNetworkConfig } from '../src/core/agents/slack-network.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const thread = 'T000FAKE/C000FAKE/1700000000.000001';
const claim = { id: 'claim-fake-494', repo: 'ashlrai/phantom', task: 'fake task', agent: 'fake-owner',
  claimedAt: now - 1000, expiresAt: now + 3_600_000 };
const binding = { v: 1, claimId: claim.id, repo: claim.repo, threadKey: thread,
  pr: 123, head: 'abcdef1234567890' };
const key = JSON.stringify(['ASSIGNED', claim.repo, claim.id, claim.agent, claim.claimedAt, binding.head]);
const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims: [claim],
  messages: [], proposals: [], expiredClaims: 0 };
const config: AgentNetworkConfig = { path: 'fake-config', state: 'ok', teamIdentities: [],
  slack: { bridgeId: 'slack', teamId: 'T000FAKE', map: [{ topic: 'fleet.claims', channel: 'C000FAKE' }] } };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claim-notice-kill-resume-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it('preserves pending work while killed and enqueues the bound thread once after resuming', async () => {
  const runsRoot = join(root, 'runs');
  const busRoot = join(root, 'bus');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(runsRoot, { mode: 0o700 });
  mkdirSync(busRoot, { mode: 0o700 });
  const prev = join(runsRoot, 'claim-notice-prev.json');
  const sent = join(runsRoot, 'claim-notice-sent.jsonl');
  const inbox = join(busRoot, 'bus-inbox', 'messages.json');
  writeFileSync(join(runsRoot, 'claim-thread-bindings.jsonl'), `${JSON.stringify(binding)}\n`, { mode: 0o600 });
  writeFileSync(prev, JSON.stringify({ v: 1, state: 'known', claims: [], messages: [], asOf: now - 60_000 }),
    { mode: 0o600 });
  const original = readFileSync(prev);
  const invoke = async (killed: boolean, flags = ['--json']) => {
    vi.mocked(console.log).mockClear();
    const code = await cmdFleetClaimNotices(flags, { runsRoot, busRoot, killed,
      readBoard: () => board, readConfig: () => config, now: () => now });
    expect(code).toBe(0);
    expect(vi.mocked(console.log).mock.calls).toHaveLength(1);
    return JSON.parse(String(vi.mocked(console.log).mock.calls[0]![0])) as Record<string, unknown>;
  };
  const unchanged = () => {
    expect(readFileSync(prev)).toEqual(original);
    expect(existsSync(sent)).toBe(false);
    expect(existsSync(join(busRoot, 'bus-inbox'))).toBe(false);
  };

  expect(await invoke(true)).toMatchObject({ status: 'halted' });
  unchanged();
  expect(await invoke(true, ['--dry-run', '--json'])).toMatchObject({ status: 'dry-run', killed: true,
    planned: 1, sent: 0, notices: [{ threadKey: thread, state: 'ASSIGNED', dedupeKey: key, result: 'planned' }] });
  unchanged();

  const resumed = await invoke(false);
  expect(resumed).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0,
    notices: [{ threadKey: thread, state: 'ASSIGNED', dedupeKey: key, result: 'sent' }] });
  const notice = (resumed.notices as { receipt: string; text: string }[])[0]!;
  const stored = JSON.parse(readFileSync(inbox, 'utf8')) as { rows: { envelope: Record<string, unknown> }[] };
  expect(stored.rows).toHaveLength(1);
  const envelope = stored.rows[0]!.envelope;
  expect(envelope).toMatchObject({ channel: 'slack', channel_ref: thread, to: 'fleet.claims',
    body: { kind: 'note', thread: 'slack:T000FAKE:C000FAKE:1700000000.000001', inReplyTo: key, text: notice.text } });
  expect(notice.receipt).toBe(`bus-note:${String(envelope.id)}`);
  expect(readFileSync(sent, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([{ v: 1, at: now, key }]);
  expect(JSON.parse(readFileSync(prev, 'utf8'))).toMatchObject({ state: 'known', claims: [claim], asOf: now });
  const busBytes = readFileSync(inbox);
  const sentBytes = readFileSync(sent);
  expect(await invoke(false)).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
  expect(await invoke(true)).toMatchObject({ status: 'halted' });
  expect(await invoke(false)).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
  expect(readFileSync(inbox)).toEqual(busBytes);
  expect(readFileSync(sent)).toEqual(sentBytes);
});
