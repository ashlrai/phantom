import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendClaimNoticeSent, claimNoticePaths, writeClaimNoticePrev } from '../src/core/fleet/claim-notice-send.js';
import { readClaimNoticeView } from '../src/core/fleet/claim-notice-view.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { SlackSendReceiptRead } from '../src/core/agents/slack-send-receipts.js';
import type { SentReceipt } from '../src/core/agents/slack-reply-binding.js';

/** Ledger rows are ms; Slack `ts` is seconds. AT puts the skew floor at exactly 1_700_000_000 s. */
const NOW = Date.parse('2026-11-14T12:00:00Z');
const AT = 1_700_000_120_000;
const TEAM = 'T00000000', CHANNEL = 'C00000000', THREAD = '1700000000.000100';
const SLASH_KEY = `${TEAM}/${CHANNEL}/${THREAD}`;
const COLON_KEY = `slack:${TEAM}:${CHANNEL}:${THREAD}`;
const REPO = 'ashlrai/phantom';

const board = (): FleetBoard =>
  ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 });
const cfg = () => () => ({ path: 'x', state: 'missing', teamIdentities: [], slack: undefined }) as never;
const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'claim-delivery-')); chmodSync(d, 0o700); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).map(name => {
  const p = join(dir, name); return [name, { bytes: readFileSync(p, 'utf8'), mtime: statSync(p).mtimeMs }];
}));

const binding = (claimId: string, repo: string, threadKey: string) =>
  `${JSON.stringify({ v: 1, claimId, repo, threadKey })}\n`;
const store = (receipts: SentReceipt[] = [], state: SlackSendReceiptRead['state'] = 'ok') =>
  (): SlackSendReceiptRead => ({ state, receipts });
const sent = (over: Partial<SentReceipt> = {}): SentReceipt =>
  ({ channel: CHANNEL, thread: THREAD, state: 'sent', ts: '1700000120.000000', ...over });

function seed(dir: string, bindings: string, rows: Array<[key: unknown[], at: number]>) {
  const paths = claimNoticePaths(dir);
  if (bindings !== '') writeFileSync(paths.bindings, bindings, { mode: 0o600 });
  for (const [key, at] of rows) appendClaimNoticeSent(paths.sent, JSON.stringify(key), at);
  writeClaimNoticePrev(paths.prev, { state: 'known', claims: [], messages: [], asOf: NOW - 60_000 });
}

const view = (dir: string, readSendReceipts: () => SlackSendReceiptRead) =>
  readClaimNoticeView({ runsRoot: dir, now: () => NOW, readBoard: board, readConfig: cfg(), readSendReceipts });

describe('claim notice delivery evidence', () => {
  it('marks slack-sent when a same-thread sent receipt follows the ledger time, writing nothing', async () => {
    const dir = mk();
    seed(dir, binding('claim-1', REPO, SLASH_KEY), [[['VERIFIED', 'claim-1', 'abc'], AT]]);
    const before = snapshot(dir);
    const result = await view(dir, store([sent()]));
    expect(result.sent.recent).toEqual([
      { state: 'VERIFIED', claimId: 'claim-1', at: AT, delivery: 'slack-sent' }]);
    expect(result.delivery).toEqual({ sendStore: 'ok', slackSent: 1, noReceipt: 0, unknown: 0 });
    expect(snapshot(dir)).toEqual(before);
  });

  it('parses the slack: grammar threadKey through the sender parser too', async () => {
    const dir = mk();
    seed(dir, binding('claim-1', REPO, COLON_KEY), [[['VERIFIED', 'claim-1', 'abc'], AT]]);
    const result = await view(dir, store([sent()]));
    expect(result.sent.recent[0]!.delivery).toBe('slack-sent');
  });

  it('counts a receipt at the exact skew boundary but not one second-fraction older', async () => {
    const dir = mk();
    seed(dir, binding('claim-1', REPO, SLASH_KEY), [[['VERIFIED', 'claim-1', 'abc'], AT]]);
    // floor = (AT - 120_000) / 1000 = 1_700_000_000.0 Slack seconds.
    const atBoundary = await view(dir, store([sent({ ts: '1700000000.000000' })]));
    expect(atBoundary.sent.recent[0]!.delivery).toBe('slack-sent');
    const older = await view(dir, store([sent({ ts: '1699999999.999999' })]));
    expect(older.sent.recent[0]!.delivery).toBe('no-slack-receipt');
  });

  it('never counts an attempted receipt or a different thread', async () => {
    const dir = mk();
    seed(dir, binding('claim-1', REPO, SLASH_KEY), [[['VERIFIED', 'claim-1', 'abc'], AT]]);
    const attempted = await view(dir, store([{ channel: CHANNEL, thread: THREAD, state: 'attempted' }]));
    expect(attempted.sent.recent[0]!.delivery).toBe('no-slack-receipt');
    const otherThread = await view(dir, store([sent({ thread: '1700000999.000000' })]));
    expect(otherThread.sent.recent[0]!.delivery).toBe('no-slack-receipt');
    const otherChannel = await view(dir, store([sent({ channel: 'C00000001' })]));
    expect(otherChannel.sent.recent[0]!.delivery).toBe('no-slack-receipt');
  });

  it('reports unknown when the claim has no binding or an unparseable threadKey', async () => {
    const dir = mk();
    seed(dir, '', [[['VERIFIED', 'claim-none', 'abc'], AT]]);
    const unbound = await view(dir, store([sent()]));
    expect(unbound.sent.recent[0]!.delivery).toBe('unknown');
    const dir2 = mk();
    seed(dir2, binding('claim-1', REPO, 'not-a-thread-ref'), [[['VERIFIED', 'claim-1', 'abc'], AT]]);
    const badRef = await view(dir2, store([sent()]));
    expect(badRef.sent.recent[0]!.delivery).toBe('unknown');
  });

  it('refuses to guess when a repo-less key names a claim bound in two repos', async () => {
    const dir = mk();
    const bindings = binding('dup', 'a/b', SLASH_KEY) + binding('dup', 'c/d', `${TEAM}/C00000001/${THREAD}`);
    seed(dir, bindings, [[['VERIFIED', 'dup', 'h'], AT]]);
    const result = await view(dir, store([sent()]));
    expect(result.sent.recent[0]!.delivery).toBe('unknown');
  });

  it('uses the repo on 4- and 6-part keys to pick the binding', async () => {
    const dir = mk();
    const bindings = binding('dup', 'a/b', SLASH_KEY) + binding('dup', 'c/d', `${TEAM}/C00000001/${THREAD}`);
    seed(dir, bindings, [
      [['VERIFIED', 'a/b', 'dup', 'h'], AT],
      [['RELEASED', 'c/d', 'dup', 'agent', 5, 'h'], AT + 1]]);
    const result = await view(dir, store([sent()]));
    expect(result.sent.recent).toEqual([
      { state: 'RELEASED', claimId: 'dup', at: AT + 1, delivery: 'no-slack-receipt' },
      { state: 'VERIFIED', claimId: 'dup', at: AT, delivery: 'slack-sent' }]);
  });

  it('accepts two bindings that resolve to one thread', async () => {
    const dir = mk();
    const bindings = binding('shared', 'a/b', SLASH_KEY) + binding('shared', 'c/d', SLASH_KEY);
    seed(dir, bindings, [[['VERIFIED', 'shared', 'h'], AT]]);
    const result = await view(dir, store([sent()]));
    expect(result.sent.recent[0]!.delivery).toBe('slack-sent');
  });

  it('reports unknown for every row on a missing or degraded store', async () => {
    const dir = mk();
    seed(dir, binding('claim-1', REPO, SLASH_KEY), [[['VERIFIED', 'claim-1', 'abc'], AT]]);
    const missing = await view(dir, store([sent()], 'missing'));
    expect(missing.sent.recent[0]!.delivery).toBe('unknown');
    expect(missing.delivery).toEqual({ sendStore: 'missing', slackSent: 0, noReceipt: 0, unknown: 1 });
    const degraded = await view(dir, store([sent()], 'degraded'));
    expect(degraded.sent.recent[0]!.delivery).toBe('unknown');
    expect(degraded.delivery.sendStore).toBe('degraded');
  });

  it('reports unknown, never a fake success, when the reader throws', async () => {
    const dir = mk();
    seed(dir, binding('claim-1', REPO, SLASH_KEY), [[['VERIFIED', 'claim-1', 'abc'], AT]]);
    const result = await view(dir, () => { throw new Error('store exploded'); });
    expect(result.sent.recent[0]!.delivery).toBe('unknown');
    expect(result.delivery).toEqual({ sendStore: 'degraded', slackSent: 0, noReceipt: 0, unknown: 1 });
  });

  it('counts each delivery word in the summary', async () => {
    const dir = mk();
    const bindings = binding('ok-claim', REPO, SLASH_KEY) + binding('missed', REPO, `${TEAM}/C00000001/${THREAD}`);
    seed(dir, bindings, [
      [['VERIFIED', 'ok-claim', 'h'], AT],
      [['RELEASED', 'missed', 'h'], AT + 1],
      [['BLOCKED', 'unbound', 'h'], AT + 2]]);
    const result = await view(dir, store([sent()]));
    expect(result.sent.recent.map(r => r.delivery)).toEqual(['unknown', 'no-slack-receipt', 'slack-sent']);
    expect(result.delivery).toEqual({ sendStore: 'ok', slackSent: 1, noReceipt: 1, unknown: 1 });
  });
});
