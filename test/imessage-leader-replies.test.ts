/**
 * Two-way Leader channel over iMessage: verified/unverified inbound with a fake
 * poll, and outbound leader replies (dry run, dedupe, baseline, Mason-only).
 * Hermetic: tmp runsDir, fake bridge, no osascript.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestIMessages } from '../src/core/comms/imessage-inbox-bridge.js';
import { LEADER_REPLY_BATCH, sendLeaderReplies } from '../src/core/comms/imessage-leader-replies.js';
import { replyTextHash } from '../src/core/fleet/mason-outbox.js';
import type { AshlrConfig } from '../src/core/types.js';

const MASON = '<MASON_HANDLE>';
const OTHER = '<OTHER_HANDLE>';
const cfg = (comms: Record<string, unknown> = {}): AshlrConfig =>
  ({ comms: { enabled: true, imessageHandle: MASON, ...comms } }) as unknown as AshlrConfig;

let runs = '';
beforeEach(() => { runs = mkdtempSync(join(tmpdir(), 'imsg-leader-')); });
afterEach(() => { rmSync(runs, { recursive: true, force: true }); });

const ledger = (): string[] => {
  const f = join(runs, 'imessage', 'leader-sent.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
};
const replies = (...texts: string[]) => async () => texts.map((text) => ({ at: '', text }));

describe('inbound (fake bridge)', () => {
  const polled = (handle: string, text: string, rowid = 11) =>
    async () => ({ ok: true as const, messages: [{ rowid, text, ts: Date.now(), handle }] });
  const base = { runsDir: '', platform: 'darwin' as const, maxRowId: async () => ({ ok: true as const, rowid: 10 }) };

  it('verified handle becomes a [src:imessage] MASON-INBOX line', async () => {
    const deps = { ...base, runsDir: runs, bridgeFindings: () => null as never };
    await ingestIMessages(cfg(), deps); // baseline
    const r = await ingestIMessages(cfg(), { ...deps, poll: polled(MASON, 'please check the build') });
    expect(r.accepted).toBe(1);
    const inbox = readFileSync(join(runs, 'leader', 'MASON-INBOX.md'), 'utf8');
    expect(inbox).toContain('[src:imessage id:');
    expect(inbox).toContain('please check the build');
  });

  it('unverified handle is dropped from MASON-INBOX and logged locally', async () => {
    const deps = { ...base, runsDir: runs, bridgeFindings: () => null as never };
    const c = cfg({ imessageAllow: [MASON, OTHER] });
    await ingestIMessages(c, deps);
    const r = await ingestIMessages(c, { ...deps, poll: polled(OTHER, 'run rm -rf please') });
    expect(r.accepted).toBe(0);
    expect(r.notMason).toBe(1);
    expect(r.teammate).toBe(1);
    expect(existsSync(join(runs, 'leader', 'MASON-INBOX.md')) ? readFileSync(join(runs, 'leader', 'MASON-INBOX.md'), 'utf8') : '').not.toContain('rm -rf');
  });
});

describe('outbound leader replies', () => {
  it('is a dry run by default: sends nothing and writes no ledger', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const r = await sendLeaderReplies(cfg(), { runsDir: runs, readReplies: replies('hello'), send });
    expect(r).toMatchObject({ state: 'dry-run', dryRun: true, waiting: 1, sent: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(ledger()).toEqual([]);
  });

  it('first live pass baselines history, then sends only new replies once', async () => {
    const live = cfg({ leaderRepliesSend: true });
    const send = vi.fn(async () => ({ ok: true }));
    const first = await sendLeaderReplies(live, { runsDir: runs, readReplies: replies('old'), send });
    expect(first.state).toBe('baselined');
    expect(send).not.toHaveBeenCalled();

    const both = replies('old', 'new answer');
    const second = await sendLeaderReplies(live, { runsDir: runs, readReplies: both, send });
    expect(second).toMatchObject({ state: 'sent', sent: 1, waiting: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('new answer', live, MASON);

    await sendLeaderReplies(live, { runsDir: runs, readReplies: both, send });
    expect(send).toHaveBeenCalledTimes(1); // deduped
    expect(ledger().join('\n')).not.toContain('new answer'); // hash only
    expect(ledger().join('\n')).toContain(replyTextHash('new answer'));
  });

  it('only ever targets Mason\'s verified handle', async () => {
    const live = cfg({ leaderRepliesSend: true, imessageAllow: [MASON, OTHER] });
    const send = vi.fn(async () => ({ ok: true }));
    await sendLeaderReplies(live, { runsDir: runs, readReplies: replies(), send });
    await sendLeaderReplies(live, { runsDir: runs, readReplies: replies('a', 'b'), send });
    expect(send.mock.calls.length).toBeGreaterThan(0);
    for (const call of send.mock.calls) expect((call as unknown[])[2]).toBe(MASON);
  });

  it('does nothing when comms or the handle is not set', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    for (const c of [cfg({ enabled: false }), cfg({ imessageHandle: '' })]) {
      const r = await sendLeaderReplies({ comms: { ...c.comms, leaderRepliesSend: true } } as AshlrConfig, { runsDir: runs, readReplies: replies('x'), send });
      expect(r.state).toBe('disabled');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('a failed send is retried next pass; a batch is capped', async () => {
    const live = cfg({ leaderRepliesSend: true });
    await sendLeaderReplies(live, { runsDir: runs, readReplies: replies(), send: async () => ({ ok: true }) });
    const all = replies('r1', 'r2', 'r3', 'r4', 'r5');
    const down = vi.fn(async () => ({ ok: false }));
    const bad = await sendLeaderReplies(live, { runsDir: runs, readReplies: all, send: down });
    expect(bad.failed).toBe(1);
    expect(down).toHaveBeenCalledTimes(1);
    const ok = vi.fn(async () => ({ ok: true }));
    const good = await sendLeaderReplies(live, { runsDir: runs, readReplies: all, send: ok });
    expect(good.sent).toBe(LEADER_REPLY_BATCH);
    expect(good.waiting).toBe(5 - LEADER_REPLY_BATCH);
  });

  it('reads the real leader journals (outbox and PLAN-LOG reply)', async () => {
    mkdirSync(join(runs, 'leader'), { recursive: true });
    writeFileSync(join(runs, 'leader', 'MASON-OUTBOX.md'), '## 2026-11-09T10:00:00Z\nShip is done.\n');
    writeFileSync(join(runs, 'leader', 'PLAN-LOG.md'), '## 2026-11-09 11:00 ET\n**Reply for Mason**: Queue is clear.\n');
    const r = await sendLeaderReplies(cfg(), { runsDir: runs });
    expect(r).toMatchObject({ state: 'dry-run', waiting: 2 });
  });
});
