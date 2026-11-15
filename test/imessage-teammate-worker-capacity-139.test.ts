import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { markTeammateTextsAnswered, readTeammateTexts, recordTeammateText, senderIdFor } from '../src/core/comms/imessage-teammate-inbox.js';
import { runTeammateResponder } from '../src/core/comms/imessage-teammate-worker.js';
import type { TeamMessageReceipt } from '../src/core/comms/imessage-teammate-transport.js';

const HANDLE = 'agent@example.test';
const SENDER = senderIdFor(HANDLE);
const NOW = 1793933400000;
const QUESTION = 'Please report the current blocker?';
const cfg = {} as AshlrConfig;
const now = () => NOW;
const receipt: TeamMessageReceipt = { rowid: 9000, sent: true, delivered: true, error: 0 };

let runsDir: string;
const stateDir = () => join(runsDir, 'imessage');
const state = () => JSON.parse(readFileSync(join(stateDir(), 'teammate-replies.json'), 'utf8')) as {
  replies: Array<{ rowid: number; state: string; at: number; text?: string; attemptedAt?: number }>;
};
const options = () => ({
  runsDir, now,
  approved: () => HANDLE,
  generate: vi.fn(async () => 'Observed work is still pending; no new result is recorded.'),
  send: vi.fn(async () => 'accepted' as const),
  reconcile: vi.fn(async () => receipt),
});
const seedTexts = (rowids: number[], at = NOW) => {
  for (const rowid of rowids) recordTeammateText({ rowid, handle: HANDLE, text: QUESTION }, runsDir, new Date(at));
};
const sentRow = (rowid: number, at = NOW) => ({
  rowid, senderId: SENDER, state: 'sent', at, claimUntil: at,
  text: `Phantom teammate reply [${rowid}]: settled.`, attemptedAt: at,
  receipt: { ...receipt, rowid: 9000 + rowid },
});
const sendingRow = (rowid: number, at = NOW) => ({
  rowid, senderId: SENDER, state: 'sending', at, claimUntil: at,
  text: `Phantom teammate reply [${rowid}]: uncertain draft.`, attemptedAt: at,
});
const writeStore = (replies: Array<Record<string, unknown>>) => {
  writeFileSync(join(stateDir(), 'teammate-replies.json'), JSON.stringify({ v: 1, replies }));
};

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'imessage-capacity-'));
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
});
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

describe('teammate worker receipt capacity', () => {
  it('replies once past 256 conclusively settled receipts and never resends after restart', async () => {
    seedTexts(Array.from({ length: 256 }, (_, i) => i + 1));
    markTeammateTextsAnswered(Array.from({ length: 256 }, (_, i) => i + 1), runsDir);
    writeStore(Array.from({ length: 256 }, (_, i) => sentRow(i + 1)));
    recordTeammateText({ rowid: 257, handle: HANDLE, text: QUESTION }, runsDir, new Date(NOW));

    const deps = options();
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ state: 'healthy', sent: 1, examined: 1 });
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.generate).toHaveBeenCalledOnce();
    const rows = state().replies;
    expect(rows).toHaveLength(256);
    expect(rows.some(row => row.rowid === 1)).toBe(false);
    expect(rows.find(row => row.rowid === 257)).toMatchObject({ state: 'sent' });
    expect(readTeammateTexts({ runsDir }).texts).toHaveLength(0);

    // Restart: evicted receipts stay answered via teammates.jsonl markers, so
    // nothing settled is ever regenerated or resent.
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ state: 'healthy', sent: 0, examined: 0 });
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.generate).toHaveBeenCalledOnce();
    expect(readTeammateTexts({ runsDir, includeAnswered: true }).texts).toHaveLength(257);
  });

  it('keeps a full store of unresolved sending rows and refuses unsafe new sends', async () => {
    // Rowid 1 is the new question; rowids 2..257 back 256 ambiguous sends whose
    // reconciliation has not yet produced an affirmative receipt.
    seedTexts([1, ...Array.from({ length: 256 }, (_, i) => i + 2)]);
    writeStore(Array.from({ length: 256 }, (_, i) => sendingRow(i + 2)));

    const deps = options();
    deps.reconcile = vi.fn(async (): Promise<TeamMessageReceipt | null> => null);
    const first = await runTeammateResponder(cfg, deps);
    expect(first.state).toBe('pending');
    expect(first.pending).toBeGreaterThanOrEqual(1);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
    const rows = state().replies;
    expect(rows).toHaveLength(256);
    expect(rows.every(row => row.state === 'sending')).toBe(true);
    expect(rows.some(row => row.rowid === 1)).toBe(false);

    // Restart proves the ambiguous rows are retained, still reconciled (never
    // resent) and still block the unanswered question honestly.
    deps.reconcile = vi.fn(async () => receipt);
    const second = await runTeammateResponder(cfg, deps);
    expect(second.sent).toBeGreaterThanOrEqual(1);
    expect(deps.send).not.toHaveBeenCalled();
    expect(state().replies).toHaveLength(256);
  });

  it('reclaims only answered terminal rows, evicting suppressed work before newer sent rows', async () => {
    // 254 terminal receipts (250 sent, 4 suppressed) + 2 unresolved sending rows.
    const terminalRowids = Array.from({ length: 254 }, (_, i) => i + 10);
    seedTexts(terminalRowids);
    markTeammateTextsAnswered(terminalRowids, runsDir);
    const terminal = [
      ...Array.from({ length: 250 }, (_, i) => sentRow(terminalRowids[i]!, NOW)),
      ...Array.from({ length: 4 }, (_, i) => ({ ...sentRow(terminalRowids[250 + i]!, NOW - 5000), state: 'suppressed' })),
    ];
    // Oldest-at rows are the unresolved sends: age alone must never evict them.
    writeStore([...terminal, sendingRow(2, NOW - 999999), sendingRow(3, NOW - 999998)]);
    recordTeammateText({ rowid: 1, handle: HANDLE, text: QUESTION }, runsDir, new Date(NOW));
    seedTexts([2, 3]);

    const deps = options();
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 3 });
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.generate).toHaveBeenCalledOnce();
    const rows = state().replies;
    expect(rows).toHaveLength(256);
    // The four oldest terminal rows are the suppressed ones; one slot was needed.
    expect(rows.some(row => row.rowid === terminalRowids[250])).toBe(false);
    expect(rows.filter(row => row.state === 'suppressed')).toHaveLength(3);
    // Interrupted settlement: the ambiguous sends reconciled to sent, never resent.
    expect(rows.find(row => row.rowid === 2)).toMatchObject({ state: 'sent' });
    expect(rows.find(row => row.rowid === 3)).toMatchObject({ state: 'sent' });
    expect(rows.find(row => row.rowid === 1)).toMatchObject({ state: 'sent' });

    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 0, examined: 0 });
    expect(deps.send).toHaveBeenCalledOnce();
  });

  it('retains terminal rows lacking answered-marker proof and reports honest pending', async () => {
    // Sent receipts with no durable answered marker are not conclusively
    // settled: they are never evicted, so a store full of them plus ambiguous
    // work yields an honest pending result instead of an unsafe send.
    writeStore([...Array.from({ length: 255 }, (_, i) => sentRow(500 + i)), sendingRow(800)]);
    seedTexts([800, 801]);

    const deps = options();
    deps.reconcile = vi.fn(async (): Promise<TeamMessageReceipt | null> => null);
    const report = await runTeammateResponder(cfg, deps);
    expect(report.state).toBe('pending');
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
    const rows = state().replies;
    expect(rows).toHaveLength(256);
    expect(rows.filter(row => row.state === 'sent')).toHaveLength(255);
    expect(rows.find(row => row.rowid === 800)).toMatchObject({ state: 'sending' });
    expect(rows.some(row => row.rowid === 801)).toBe(false);
  });
});
