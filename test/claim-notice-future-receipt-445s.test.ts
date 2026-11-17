import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { slackSendStoreKey } from '../src/core/agents/slack-reply-identity.js';
import type { SlackSendReceiptRead } from '../src/core/agents/slack-send-receipts.js';
import { appendClaimNoticeSent, claimNoticePaths } from '../src/core/fleet/claim-notice-send.js';
import { readClaimNoticeView } from '../src/core/fleet/claim-notice-view.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-15T12:00:00.000Z');
const at = now - 60_000;
const claim = { id: 'claim-fake-445', repo: 'ashlrai/phantom', task: 'fake task', agent: 'fake-owner',
  claimedAt: now - 1000, expiresAt: now + 3_600_000 };
const threadKey = 'T00000000/C00000000/1700000000.000100';
const channel = 'C00000000';
const threadTs = '1700000000.000100';
const noticeDedupeKey = JSON.stringify(['VERIFIED', claim.repo, claim.id, 'agent', 5, 'tail']);
const noticeReceiptKey = slackSendStoreKey(
  `claim-notice-${createHash('sha256').update(noticeDedupeKey).digest('hex').slice(0, 24)}`,
);
const board = (): FleetBoard =>
  ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 });
const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'claim-view-445-')); chmodSync(d, 0o700); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).map(name => {
  const p = join(dir, name); return [name, { bytes: readFileSync(p, 'utf8'), mtime: statSync(p).mtimeMs }];
}));
const cfg = () => () => ({ path: 'x', state: 'missing', teamIdentities: [] }) as never;

/** ms → canonical Slack `<seconds>.<microseconds>` ts. */
const tsAt = (ms: number): string =>
  `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}000`;

function seed(dir: string) {
  const paths = claimNoticePaths(dir);
  writeFileSync(paths.bindings,
    `${JSON.stringify({ v: 1, claimId: claim.id, repo: claim.repo, threadKey, pr: 1, head: 'abcdef1' })}\n`,
    { mode: 0o600 });
  appendClaimNoticeSent(paths.sent, noticeDedupeKey, at);
}

const store = (receipts: SentReceipt[]): SlackSendReceiptRead => ({ state: 'ok', receipts });
const receipt = (over: Partial<SentReceipt> = {}): SentReceipt =>
  ({ key: noticeReceiptKey, channel, thread: threadTs, state: 'sent', ts: tsAt(now - 30_000), ...over });

async function deliveryOf(dir: string, receipts: SentReceipt[]) {
  const view = await readClaimNoticeView({ runsRoot: dir, now: () => now, readBoard: board,
    readConfig: cfg(), readSendReceipts: () => store(receipts) });
  expect(view.sent.recent).toHaveLength(1);
  return view;
}

describe('readClaimNoticeView receipt window (RQ-PHX-NOTICEFUTUREBOUND445S)', () => {
  it('accepts receipts inside the skew window, at the skew floor and at the collection boundary', async () => {
    const dir = mk(); seed(dir);
    for (const ts of [tsAt(now - 30_000), tsAt(at - 120_000), tsAt(now)]) {
      const view = await deliveryOf(dir, [receipt({ ts })]);
      expect(view.sent.recent[0]!.delivery).toBe('slack-sent');
    }
  });

  it('rejects future, malformed, nonfinite, wrong-channel, wrong-thread and non-sent receipts', async () => {
    const dir = mk(); seed(dir);
    const cases: SentReceipt[] = [
      receipt({ ts: tsAt(now + 1_000) }),
      receipt({ ts: 'not-a-ts' }),
      receipt({ ts: 'Infinity' }),
      receipt({ ts: tsAt(at - 120_001) }),
      receipt({ channel: 'C99999999' }),
      receipt({ thread: '1700000000.999999' }),
      receipt({ state: 'attempted' }),
      receipt({ ts: undefined }),
    ];
    for (const r of cases) {
      const view = await deliveryOf(dir, [r]);
      expect(view.sent.recent[0]!.delivery).toBe('no-slack-receipt');
    }
  });

  it('still reports slack-sent when a valid receipt sits beside a future one', async () => {
    const dir = mk(); seed(dir);
    const view = await deliveryOf(dir, [receipt({ ts: tsAt(now + 60_000) }), receipt()]);
    expect(view.sent.recent[0]!.delivery).toBe('slack-sent');
    expect(view.delivery).toMatchObject({ sendStore: 'ok', slackSent: 1, noReceipt: 0, unknown: 0 });
  });

  it('stamps generatedAt from the captured collection time and writes nothing', async () => {
    const dir = mk(); seed(dir);
    const before = snapshot(dir);
    const view = await readClaimNoticeView({ runsRoot: dir, now: () => now, readBoard: board,
      readConfig: cfg(), readSendReceipts: () => store([receipt()]) });
    expect(view.generatedAt).toBe(new Date(now).toISOString());
    expect(snapshot(dir)).toEqual(before);
    expect(view.pending).toEqual([]);
  });
});
