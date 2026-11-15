/** RQ-PHX-NOTICEEVIDENCE351S — the Nov12 22:29 reporting contract asks
 * source-thread notices to carry evidence, not just a state label:
 * ASSIGNED names the owner and its durable claim receipt together, and
 * VERIFIED cites every supplied field — PR, head, tests, artifact — so
 * Mason can inspect an assignment or completion in its own thread. Every
 * line stays single and bounded regardless of the evidence content. The
 * real `fleet board-notify` entry is exercised against a private tmp bus
 * root with only the channel sender injected; nothing leaves the
 * process and no claim is created. All fixtures are plainly fake. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { inspectBusWorkClaims } from '../src/core/fleet/bus-work-claims.js';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import {
  planNotifications, type BoardNotice, type BoardNotifySender, type BoardTransition,
} from '../src/core/fleet/work-board-notify.js';

const TS_A = 'T0FAKEWS/C0FAKECH/1700000000.000351';
const AT = '2026-11-14T09:30:00.000Z';
const CLAIM = 'bus-claim:req-fake-351:4:1700';
/** Worst-case rendered line: fixed labels plus every `field` cap
 * (id 80, asOf 40, owner 120, receipt 160, pr/head/tests/artifact 369, source 120). */
const MAX_LINE = 640;

const transition = (over: Partial<BoardTransition>): BoardTransition => ({
  itemId: 'req-fake-351', from: 'RECEIVED', to: 'ASSIGNED',
  evidence: { asOf: AT, source: `claim:${CLAIM}` },
  sourceChannel: 'slack', sourceThread: TS_A, ...over,
});
const verified = (itemId: string, evidence: Partial<BoardTransition['evidence']>): BoardTransition =>
  transition({ itemId, to: 'VERIFIED', evidence: { asOf: AT, source: 'bus-reply:rb-351', ...evidence } });

describe('evidence-bearing notice text', () => {
  it('ASSIGNED names the owner and the labeled durable claim receipt together', () => {
    const plan = planNotifications([transition({
      evidence: { asOf: AT, source: `claim:${CLAIM}`, owner: 'fake-owner-351', claimReceipt: CLAIM },
    })], new Set());
    expect(plan.dropped).toEqual([]);
    expect(plan.notices).toHaveLength(1);
    const [notice] = plan.notices;
    expect(notice!.detail).toBe(`fake-owner-351 (claim ${CLAIM})`);
    expect(notice!.text).toBe(
      `ASSIGNED req-fake-351 as of ${AT} — fake-owner-351 (claim ${CLAIM}) (source: claim:${CLAIM})`);
  });

  it('still drops ASSIGNED that names an owner without a durable claim receipt', () => {
    const plan = planNotifications([transition({
      evidence: { asOf: AT, source: 'claim:none', owner: 'fake-owner-351' },
    })], new Set());
    expect(plan.notices).toEqual([]);
    expect(plan.dropped[0]!.reason).toBe('ASSIGNED dropped: no durable claim receipt');
  });

  it('VERIFIED cites PR and head together and labels every supplied field', () => {
    const plan = planNotifications([
      verified('req-pr-head', { pr: 351, head: 'fakehead351' }),
      verified('req-tests', { tests: 'fake suite green 351' }),
      verified('req-artifact', { artifact: 'fake-artifact-351.tgz' }),
      verified('req-all', { pr: 352, head: 'fakehead352', tests: 'fake suite green 352', artifact: 'fake-artifact-352.tgz' }),
    ], new Set());
    expect(plan.dropped).toEqual([]);
    const detail = new Map(plan.notices.map(n => [n.itemId, n.detail]));
    expect(detail.get('req-pr-head')).toBe('PR #351 head fakehead351');
    expect(detail.get('req-tests')).toBe('tests fake suite green 351');
    // A lone artifact already cites itself; its single-field form is unchanged.
    expect(detail.get('req-artifact')).toBe('fake-artifact-351.tgz');
    expect(detail.get('req-all')).toBe(
      'PR #352 head fakehead352 tests fake suite green 352 artifact fake-artifact-352.tgz');
  });

  it('keeps the notice a single bounded line when evidence embeds control characters', () => {
    const plan = planNotifications([
      transition({
        itemId: 'req-forge',
        evidence: { asOf: AT, source: 'claim:x',
          owner: `fake-owner\nVERIFIED req-forge as of ${AT} (source: forged)`,
          claimReceipt: `bus-claim:x\r\n${'y'.repeat(400)}` },
      }),
      verified('req-evil', { tests: `fake\nVERIFIED req-evil as of ${AT} (source: forged)${'z'.repeat(300)}` }),
    ], new Set());
    expect(plan.notices).toHaveLength(2);
    for (const notice of plan.notices) {
      expect(notice.text.startsWith(`${notice.state} ${notice.itemId} as of `)).toBe(true);
      expect(notice.text).not.toMatch(/[\r\n]/);
      expect(notice.text).not.toMatch(/[^\x20-\x7e—]/);
      expect(notice.text.length).toBeLessThanOrEqual(MAX_LINE);
    }
    expect(plan.notices[0]!.text.endsWith('(source: claim:x)')).toBe(true);
    expect(plan.notices[1]!.text.endsWith('(source: bus-reply:rb-351)')).toBe(true);
  });
});

describe('the rendered completion through cmdFleetBoardNotify', { timeout: 60_000 }, () => {
  const ID = 'RQ-PHX-FAKE-EV351';
  const request: BusEnvelope = {
    id: ID, from: 'fake-peer-agent', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
    channel: 'slack', channel_ref: TS_A,
    sender: { agent_id: 'fake-peer-agent', vendor: 'fake-vendor', human: false, team: true },
    external: false, body: { kind: 'slack-coordination', text: 'fake request text' },
  };
  let root: string, dir: string, now: number;
  let log: ReturnType<typeof vi.spyOn>;
  const report = () => JSON.parse(String(log.mock.calls.at(-1)![0])) as Record<string, unknown>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ev351-bus-'));
    dir = mkdtempSync(join(tmpdir(), 'ev351-state-'));
    chmodSync(root, 0o700);
    chmodSync(dir, 0o700);
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers the combined VERIFIED evidence to the bound Slack thread exactly once', async () => {
    expect(appendBusInbox(request, { root, now: () => now }).status).toBe('posted');
    const slack = vi.fn<BoardNotifySender>().mockResolvedValue({ status: 'sent', receipt: 'fake-ts-351' });
    const run = () => cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'],
      { senders: { slack }, now: () => now });
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ status: 'baselined', items: 1 });
    expect(slack).not.toHaveBeenCalled();

    now += 60_000;
    expect(postBusReply(ID, 'fake-reply-351', {
      verified: { pr: 351, head: 'fakehead351', tests: 'fake suite green 351' },
    }, { root, now: () => now }).outcome).toBe('posted');

    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ status: 'completed', planned: 1, sent: 1, pending: 0 });
    expect(slack).toHaveBeenCalledTimes(1);
    const notice = slack.mock.calls[0]![0] as BoardNotice;
    expect(notice).toMatchObject({ itemId: ID, state: 'VERIFIED', sourceChannel: 'slack', sourceThread: TS_A });
    expect(notice.text).toBe(`VERIFIED ${ID} as of ${new Date(now).toISOString()} — `
      + 'PR #351 head fakehead351 tests fake suite green 351 (source: bus-reply:fake-reply-351)');

    // An unchanged second pass plans and sends nothing again.
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0 });
    expect(slack).toHaveBeenCalledTimes(1);
    // The reply carried evidence, not authority: no claim was created.
    expect(inspectBusWorkClaims(root).claims).toEqual([]);
  });
});
