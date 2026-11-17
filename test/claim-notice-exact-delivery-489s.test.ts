import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { appendClaimNoticeSent, claimNoticePaths } from '../src/core/fleet/claim-notice-send.js';
import { readClaimNoticeView } from '../src/core/fleet/claim-notice-view.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = 1_800_000_000_000;
const at = now - 30_000;
const channel = 'C00000000', thread = '1700000000.000100';
const repo = 'fake/repo', claimId = 'fake-claim';
const keys = ['ASSIGNED', 'VERIFIED'].map(state => JSON.stringify([state, repo, claimId, 'fake', 1, 'tail']));
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
// Independently mirror the existing producer + transport contract.
const identity = (key: string) => hash(`claim-notice-${hash(key).slice(0, 24)}`);
const exact = identity(keys[1]!);
const receipt = { state: 'sent', channel, thread, ts: '1799999990.000000',
  clientId: 'fake-client', digest: 'fake-digest', body: 'private fake body' };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'exact-notice-489s-'));
  chmodSync(dir, 0o700); dirs.push(dir);
  const paths = claimNoticePaths(dir);
  writeFileSync(paths.bindings, `${JSON.stringify({ v: 1, claimId, repo,
    threadKey: `T00000000/${channel}/${thread}` })}\n`, { mode: 0o600 });
  for (const key of keys) appendClaimNoticeSent(paths.sent, key, at);
  const path = join(dir, 'messages.json');
  const write = (messages: Record<string, unknown>) =>
    writeFileSync(path, JSON.stringify({ version: 1, messages }), { mode: 0o600 });
  const read = () => readClaimNoticeView({ runsRoot: dir, now: () => now,
    readConfig: () => ({ path: 'fake', state: 'missing', teamIdentities: [] }),
    readBoard: (): FleetBoard => ({ schema: 'fleet.coordination.v1', state: 'known',
      claims: [], messages: [], proposals: [], expiredClaims: 0 }),
    readSendReceipts: () => readSlackSendReceipts({ stateRoot: dir }) });
  return { dir, paths, path, write, read };
}

it('binds only the exact notice across fresh disk readers and keeps identity private', async () => {
  const f = fixture();
  f.write({ [exact]: receipt, [hash('normal-reply')]: receipt });
  const before = [f.paths.sent, f.paths.bindings, f.path].map(p => readFileSync(p, 'utf8'));
  for (let restart = 0; restart < 2; restart++) {
    const view = await f.read();
    expect(view.sent.recent.map(r => [r.state, r.delivery])).toEqual([
      ['VERIFIED', 'slack-sent'], ['ASSIGNED', 'no-slack-receipt'],
    ]);
    expect(view.delivery).toEqual({ sendStore: 'ok', slackSent: 1, noReceipt: 1, unknown: 0 });
    const output = JSON.stringify(view);
    for (const privateValue of [exact, ...keys, f.dir, 'fake-client', 'fake-digest', 'private fake body']) {
      expect(output).not.toContain(privateValue);
    }
  }
  expect([f.paths.sent, f.paths.bindings, f.path].map(p => readFileSync(p, 'utf8'))).toEqual(before);
});

it.each([
  ['normal reply', { [hash('normal-reply')]: receipt }, 'ok'],
  ['attempted exact identity', { [exact]: { ...receipt, state: 'attempted' } }, 'ok'],
  ['wrong thread', { [exact]: { ...receipt, thread: '1700000001.000000' } }, 'ok'],
  ['wrong channel', { [exact]: { ...receipt, channel: 'C00000001' } }, 'ok'],
  ['future receipt', { [exact]: { ...receipt, ts: '1800000000.001000' } }, 'ok'],
  ['old receipt', { [exact]: { ...receipt, ts: '1799999849.999999' } }, 'ok'],
  ['damaged store', { [exact]: receipt, invalid: receipt }, 'degraded'],
] as const)('cannot establish delivery from %s', async (_name, messages, state) => {
  const f = fixture(); f.write(messages);
  const view = await f.read();
  expect(view.delivery.sendStore).toBe(state);
  expect(view.sent.recent.map(r => r.delivery)).toEqual(Array(2).fill(
    state === 'ok' ? 'no-slack-receipt' : 'unknown'));
});

it.each(['1799999850.000000', '1800000000.000000'])(
  'accepts exact sent evidence at the receipt window boundary %s', async ts => {
    const f = fixture(); f.write({ [exact]: { ...receipt, ts } });
    expect((await f.read()).sent.recent.map(r => r.delivery)).toEqual(['slack-sent', 'no-slack-receipt']);
  });
