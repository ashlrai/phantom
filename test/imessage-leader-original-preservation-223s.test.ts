/**
 * Preservation of PR #4552 (RQ-IMSGLEADERN9SQ8): the Phantom-owned iMessage
 * Leader reply path. Exercises the real exported `sendLeaderReplies` against a
 * temporary runsDir with injected fake `readReplies`/`send` seams — no bridge
 * process, no osascript, no real handles or messages.
 *
 * The pass is stateless: every call re-reads the on-disk ledger
 * (<runs>/imessage/leader-sent.jsonl), so each invocation below stands in for a
 * restarted CLI poll or sidecar pass. Covered here: first-live-pass baseline of
 * history, a new reply whose first send fails and is retried by a later pass,
 * duplicate suppression, hash/status-only ledger rows (never plaintext), the
 * verified Mason handle as the only send destination, an empty dry run on a
 * separate root, and master's newer leader-replies.lock busy protection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendLeaderReplies } from '../src/core/comms/imessage-leader-replies.js';
import { replyTextHash } from '../src/core/fleet/mason-outbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import type { AshlrConfig } from '../src/core/types.js';

const MASON = '<MASON_HANDLE>';
const OTHER = '<OTHER_HANDLE>';
const cfg = (comms: Record<string, unknown> = {}): AshlrConfig =>
  ({ comms: { enabled: true, imessageHandle: MASON, ...comms } }) as unknown as AshlrConfig;

let runs = '';
beforeEach(() => { runs = mkdtempSync(join(tmpdir(), 'imsg-leader-4552-')); });
afterEach(() => { rmSync(runs, { recursive: true, force: true }); });

const ledgerFile = (): string => join(runs, 'imessage', 'leader-sent.jsonl');
const ledgerRows = (): { at: string; hash: string; status: string }[] =>
  (existsSync(ledgerFile()) ? readFileSync(ledgerFile(), 'utf8') : '')
    .split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { at: string; hash: string; status: string });
const replies = (...texts: string[]) => async () => texts.map((text) => ({ at: '', text }));

describe('PR #4552 leader replies preservation', () => {
  it('survives restart: baseline, failed send retried once, duplicates suppressed, hash-only ledger, Mason-only destination', async () => {
    // imessageAllow lists a second handle; it must never become a destination.
    const live = cfg({ leaderRepliesSend: true, imessageAllow: [MASON, OTHER] });
    const send = vi.fn(async (_text: string, _cfg: AshlrConfig, _to: string) => ({ ok: true }));
    const failing = vi.fn(async (_text: string, _cfg: AshlrConfig, _to: string) => ({ ok: false }));

    // Pass 1 (fresh ledger): history is baselined, never texted out.
    const baseline = await sendLeaderReplies(live, {
      runsDir: runs, readReplies: replies('historic reply one'), send,
    });
    expect(baseline).toMatchObject({ state: 'baselined', dryRun: false, sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(ledgerRows().map((row) => row.status)).toEqual(['baseline', 'baseline']);

    // Pass 2 (as after a restart): one new reply; its first send fails.
    const history = replies('historic reply one', 'fresh answer');
    const second = await sendLeaderReplies(live, { runsDir: runs, readReplies: history, send: failing });
    expect(second).toMatchObject({ state: 'sent', sent: 0, failed: 1, waiting: 1 });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledWith('fresh answer', live, MASON);

    // Pass 3: the failed reply is retried and sent; history stays suppressed.
    const third = await sendLeaderReplies(live, { runsDir: runs, readReplies: history, send });
    expect(third).toMatchObject({ state: 'sent', sent: 1, failed: 0, waiting: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('fresh answer', live, MASON);

    // Pass 4: nothing is replayed — neither the sent reply nor the baseline.
    const fourth = await sendLeaderReplies(live, { runsDir: runs, readReplies: history, send });
    expect(fourth).toMatchObject({ state: 'sent', sent: 0, failed: 0, waiting: 0 });
    expect(send).toHaveBeenCalledTimes(1);

    // Every fake send was addressed to the verified Mason handle and nothing else.
    const destinations = [...send.mock.calls, ...failing.mock.calls].map((call) => call[2]);
    expect(destinations.length).toBeGreaterThan(0);
    for (const to of destinations) expect(to).toBe(MASON);

    // The receipt ledger carries hashes and statuses only — never reply text.
    const rows = ledgerRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.at).toBe('string');
      expect(row.at.length).toBeGreaterThan(0);
      expect(typeof row.hash).toBe('string');
      expect(['pending', 'sent', 'failed', 'baseline'].includes(row.status)).toBe(true);
    }
    expect(rows.filter((row) => row.hash === replyTextHash('fresh answer')).map((row) => row.status))
      .toEqual(['pending', 'failed', 'pending', 'sent']);
    expect(rows.some((row) => row.hash === replyTextHash('historic reply one') && row.status === 'baseline')).toBe(true);
    const raw = readFileSync(ledgerFile(), 'utf8');
    expect(raw).not.toContain('fresh answer');
    expect(raw).not.toContain('historic reply one');
    expect(raw).toContain(replyTextHash('fresh answer'));
    expect(statSync(ledgerFile()).mode & 0o777).toBe(0o600);
  });

  it('default dry run on a separate root reports waiting replies but writes no state and sends nothing', async () => {
    const dryRoot = mkdtempSync(join(tmpdir(), 'imsg-leader-4552-dry-'));
    try {
      const send = vi.fn(async (_text: string, _cfg: AshlrConfig, _to: string) => ({ ok: true }));
      const r = await sendLeaderReplies(cfg(), { runsDir: dryRoot, readReplies: replies('never sent'), send });
      expect(r).toMatchObject({ state: 'dry-run', dryRun: true, waiting: 1, sent: 0, failed: 0 });
      expect(send).not.toHaveBeenCalled();
      // A dry run creates neither the state dir nor the ledger, so enabling
      // sends later still delivers everything that was only counted.
      expect(existsSync(join(dryRoot, 'imessage'))).toBe(false);
      expect(existsSync(join(dryRoot, 'imessage', 'leader-sent.jsonl'))).toBe(false);
    } finally {
      rmSync(dryRoot, { recursive: true, force: true });
    }
  });

  it('a live pass is busy while another holder keeps leader-replies.lock and records nothing', async () => {
    const live = cfg({ leaderRepliesSend: true });
    const dir = join(runs, 'imessage');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const held = acquireLocalStoreLockWithOutcome(join(dir, 'leader-replies.lock'), 0, { anchorPath: dir });
    expect(held.state).toBe('acquired');
    try {
      const send = vi.fn(async (_text: string, _cfg: AshlrConfig, _to: string) => ({ ok: true }));
      const r = await sendLeaderReplies(live, { runsDir: runs, readReplies: replies('racing reply'), send });
      expect(r).toMatchObject({ state: 'busy', dryRun: false, sent: 0 });
      expect(send).not.toHaveBeenCalled();
      expect(existsSync(ledgerFile())).toBe(false);
    } finally {
      if (held.state === 'acquired') releaseLocalStoreLock(held.lock);
    }
  });
});
