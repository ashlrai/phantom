/**
 * RQ-SWE3-IMSGDEEP-1: chunked PATCH-BEGIN/PART/END transfers from the dot.
 *
 * Hermetic: runsDir and the bus root are tmp dirs, handles are placeholders,
 * chat.db rows arrive as IntakeMsg fixtures through the poll seam, and
 * node:child_process is mocked so no osascript or sqlite3 ever runs. Asserts
 * never print message text or handles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (file: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      cb(null, '', '');
      return {} as ReturnType<typeof actual.execFile>;
    },
  };
});

import {
  isPatchFrameText, parsePatchFrame, readPatchReceipts, recordPatchFrame, sweepPatchTransfers,
  PATCH_MAX_OPEN, PATCH_MAX_PARTS, PATCH_TRANSFER_TTL_MS, type PatchReceipt,
} from '../src/core/comms/imessage-patch-transfer.js';
import { ingestIMessages, senderIdFor } from '../src/core/comms/imessage-inbox-bridge.js';
import { bridgeTeammateFindings, TEAMMATE_FINDINGS_TOPIC } from '../src/core/comms/imessage-findings-bridge.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { readCursor, writeCursor, type IntakeMsg } from '../src/core/integrations/imessage.js';
import type { AshlrConfig } from '../src/core/types.js';

const MASON = 'mason@example.test';
const TEAMMATE = 'teammate@example.test';
const OTHER = 'other@example.test';
const NOW = new Date('2026-11-07T12:00:00Z');
const PATCH_BODY = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
const SHA = createHash('sha256').update(PATCH_BODY, 'utf8').digest('hex');

const cfg = (): AshlrConfig =>
  ({ comms: { enabled: true, imessageHandle: MASON, imessageAllow: [MASON, TEAMMATE, OTHER] } }) as AshlrConfig;
const row = (rowid: number, text: string, handle = TEAMMATE): IntakeMsg => ({ rowid, handle, text, ts: 1 });
const msg = (rowid: number, text: string, handle = TEAMMATE) => ({ rowid, handle, text });

let runsDir = '';
let busRoot = '';
let previousHome: string | undefined;
let home = '';

const dir = () => join(runsDir, 'imessage');
const patches = () => join(dir(), 'patches');
const ingest = (messages: IntakeMsg[], now = NOW) =>
  ingestIMessages(cfg(), { runsDir, busRoot, now: () => now, platform: 'darwin', poll: async () => ({ ok: true, messages }) });
const bridge = (options: Parameters<typeof bridgeTeammateFindings>[0] = {}) =>
  bridgeTeammateFindings({ runsDir, busRoot, now: () => NOW, ...options });
const busEnvelopes = () => {
  const page = listBusInboxAfter(0, 100, { root: busRoot });
  return page.status === 'ok' ? page.messages.map((m) => m.envelope) : [];
};
const receipt = (id: string): PatchReceipt =>
  JSON.parse(readFileSync(join(patches(), `${id}.receipt.json`), 'utf8')) as PatchReceipt;

/** Cut one payload into N chunks and emit valid frame texts, shuffled order optional. */
const frames = (id: string, payload: string, parts: number, order?: number[]): IntakeMsg[] => {
  const sha = createHash('sha256').update(payload, 'utf8').digest('hex');
  const size = Math.ceil(payload.length / parts);
  const indexes = order ?? Array.from({ length: parts }, (_, i) => i + 1);
  const rows: IntakeMsg[] = [row(0, `PATCH-BEGIN ${id} ${parts} ${sha}`)];
  for (const i of indexes) rows.push(row(0, `PATCH-PART ${id} ${i}/${parts}\n${payload.slice((i - 1) * size, i * size)}`));
  rows.push(row(0, `PATCH-END ${id} ${sha}`));
  return rows.map((r, i) => ({ ...r, rowid: i + 1 }));
};

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'imsg-patch-home-'));
  runsDir = mkdtempSync(join(tmpdir(), 'imsg-patch-runs-'));
  busRoot = mkdtempSync(join(tmpdir(), 'imsg-patch-bus-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(busRoot, { recursive: true, force: true });
});

describe('parsePatchFrame / isPatchFrameText', () => {
  it('parses well-formed frames', () => {
    expect(parsePatchFrame(`PATCH-BEGIN fix-1 2 ${SHA}`)).toEqual({ kind: 'begin', id: 'fix-1', parts: 2, sha256: SHA });
    expect(parsePatchFrame(`PATCH-PART fix-1 1/2\nhello`)).toEqual({ kind: 'part', id: 'fix-1', index: 1, parts: 2, chunk: 'hello' });
    expect(parsePatchFrame(`PATCH-END fix-1 ${SHA}`)).toEqual({ kind: 'end', id: 'fix-1', sha256: SHA });
    expect(parsePatchFrame(`PATCH-END fix-1 ${SHA}\n`)).toEqual({ kind: 'end', id: 'fix-1', sha256: SHA });
  });

  it('returns null for ordinary texts and ' + "'malformed' for bad markers", () => {
    expect(parsePatchFrame('gate is red')).toBeNull();
    expect(parsePatchFrame('PATCHES everywhere')).toBeNull();
    expect(parsePatchFrame('PATCH-BEGIN')).toBe('malformed');
    expect(parsePatchFrame('PATCH-BEGIN id 2 nothex')).toBe('malformed');
    expect(parsePatchFrame(`PATCH-BEGIN ../escape 2 ${SHA}`)).toBe('malformed');
    expect(parsePatchFrame(`PATCH-BEGIN id 0 ${SHA}`)).toBe('malformed');
    expect(parsePatchFrame(`PATCH-BEGIN id ${PATCH_MAX_PARTS + 1} ${SHA}`)).toBe('malformed');
    expect(parsePatchFrame(`PATCH-PART id 0/2\nx`)).toBe('malformed');
    expect(parsePatchFrame(`PATCH-PART id 3/2\nx`)).toBe('malformed');
    expect(parsePatchFrame('PATCH-PART id 1/2')).toBe('malformed');
    expect(parsePatchFrame(`PATCH-END id ${'z'.repeat(64)}`)).toBe('malformed');
    expect(parsePatchFrame(`PATCH-BEGIN id 2 ${SHA}\ntrailing content`)).toBe('malformed');
    expect(parsePatchFrame(`PATCH-PART id 1/1\n${'x'.repeat(20_000)}`)).toBe('malformed');
  });

  it('detects every marker for the findings filter', () => {
    expect(isPatchFrameText('PATCH-BEGIN x 1 a')).toBe(true);
    expect(isPatchFrameText('PATCH-PART x 1/1\nc')).toBe(true);
    expect(isPatchFrameText('PATCH-END x a')).toBe(true);
    expect(isPatchFrameText('a PATCH-BEGIN in the middle')).toBe(false);
    expect(isPatchFrameText('PATCH-FOO x')).toBe(false);
  });
});

describe('recordPatchFrame', () => {
  const frame = (rowid: number, text: string, handle = TEAMMATE) =>
    recordPatchFrame(msg(rowid, text, handle), { runsDir, now: () => NOW });

  it('leaves ordinary texts untouched', () => {
    expect(frame(1, 'hello teammate')).toMatchObject({ handled: false });
    expect(existsSync(patches())).toBe(false);
  });

  it('assembles a verified artifact from begin/parts/end, mode 0600', () => {
    for (const r of frames('fix-1', PATCH_BODY, 2)) {
      const result = frame(r.rowid, r.text);
      if (r.rowid < 4) expect(result).toMatchObject({ handled: true, outcome: 'consumed', id: 'fix-1' });
      else expect(result).toMatchObject({ handled: true, outcome: 'completed', id: 'fix-1' });
    }
    const artifact = join(patches(), 'fix-1.patch');
    expect(readFileSync(artifact, 'utf8')).toBe(PATCH_BODY);
    expect(statSync(artifact).mode & 0o777).toBe(0o600);
    expect(statSync(join(patches(), 'fix-1.receipt.json')).mode & 0o777).toBe(0o600);
    expect(receipt('fix-1')).toMatchObject({ v: 1, id: 'fix-1', outcome: 'verified', sha256: SHA, parts: 2, bytes: Buffer.byteLength(PATCH_BODY), rowids: [1, 2, 3, 4], senderId: senderIdFor(TEAMMATE) });
    expect(existsSync(join(patches(), 'open', 'fix-1.json'))).toBe(false);
    expect(JSON.stringify(receipt('fix-1'))).not.toContain(TEAMMATE);
    expect(readPatchReceipts({ runsDir })).toMatchObject({ state: 'healthy', receipts: [{ id: 'fix-1', outcome: 'verified' }] });
  });

  it('assembles out-of-order parts and parts arriving after END', () => {
    for (const r of frames('late-1', PATCH_BODY, 2, [2, 1])) frame(r.rowid, r.text);
    expect(readFileSync(join(patches(), 'late-1.patch'), 'utf8')).toBe(PATCH_BODY);
  });

  it('rejects on sha256 mismatch and spends the id forever', () => {
    const bad = `PATCH-END bad-1 ${'0'.repeat(64)}`;
    expect(frame(1, `PATCH-BEGIN bad-1 1 ${SHA}`)).toMatchObject({ outcome: 'consumed' });
    expect(frame(2, `PATCH-PART bad-1 1/1\n${PATCH_BODY}`)).toMatchObject({ outcome: 'consumed' });
    expect(frame(3, bad)).toMatchObject({ outcome: 'rejected', id: 'bad-1' });
    expect(existsSync(join(patches(), 'bad-1.patch'))).toBe(false);
    expect(receipt('bad-1')).toMatchObject({ outcome: 'rejected', reason: 'hash-mismatch' });
    expect(frame(4, `PATCH-BEGIN bad-1 1 ${SHA}`)).toMatchObject({ outcome: 'refused' });
  });

  it('rejects conflicting parts and conflicting re-begins', () => {
    expect(frame(1, `PATCH-BEGIN c-1 2 ${SHA}`)).toMatchObject({ outcome: 'consumed' });
    expect(frame(2, `PATCH-PART c-1 1/2\nfirst`)).toMatchObject({ outcome: 'consumed' });
    expect(frame(3, `PATCH-PART c-1 1/2\ndifferent`)).toMatchObject({ outcome: 'rejected', id: 'c-1' });
    expect(receipt('c-1')).toMatchObject({ outcome: 'rejected', reason: 'conflict' });

    expect(frame(4, `PATCH-BEGIN c-2 2 ${SHA}`)).toMatchObject({ outcome: 'consumed' });
    expect(frame(5, `PATCH-BEGIN c-2 3 ${SHA}`)).toMatchObject({ outcome: 'rejected', id: 'c-2' });
  });

  it('rejects a part count that disagrees with the open transfer', () => {
    expect(frame(1, `PATCH-BEGIN n-1 3 ${SHA}`)).toMatchObject({ outcome: 'consumed' });
    expect(frame(2, `PATCH-PART n-1 1/2\nx`)).toMatchObject({ outcome: 'rejected', id: 'n-1' });
  });

  it('keeps an identical re-begin idempotent', () => {
    expect(frame(1, `PATCH-BEGIN same-1 2 ${SHA}`)).toMatchObject({ outcome: 'consumed' });
    expect(frame(2, `PATCH-BEGIN same-1 2 ${SHA}`)).toMatchObject({ outcome: 'consumed' });
    expect(existsSync(join(patches(), 'open', 'same-1.json'))).toBe(true);
  });

  it('refuses frames without a begin and secret-shaped chunks', () => {
    expect(frame(1, `PATCH-PART orphan 1/1\nx`)).toMatchObject({ outcome: 'refused' });
    expect(frame(2, `PATCH-END orphan ${SHA}`)).toMatchObject({ outcome: 'refused' });
    expect(frame(3, 'PATCH-BEGIN wrong shape')).toMatchObject({ outcome: 'refused' });
    expect(frame(4, `PATCH-PART leak 1/1\nsk-test-FAKEFAKEFAKE`)).toMatchObject({ outcome: 'refused' });
  });

  it('rejects a second sender mid-transfer', () => {
    expect(frame(1, `PATCH-BEGIN duo-1 2 ${SHA}`)).toMatchObject({ outcome: 'consumed' });
    expect(frame(2, `PATCH-PART duo-1 1/2\nx`, OTHER)).toMatchObject({ outcome: 'rejected', id: 'duo-1' });
    expect(receipt('duo-1')).toMatchObject({ outcome: 'rejected', reason: 'conflict', senderId: senderIdFor(TEAMMATE) });
  });

  it('dedupes frame rowids across polls', () => {
    expect(frame(7, `PATCH-BEGIN dedup-1 1 ${SHA}`)).toMatchObject({ outcome: 'consumed' });
    expect(frame(7, `PATCH-BEGIN dedup-1 1 ${SHA}`)).toMatchObject({ outcome: 'duplicate' });
  });

  it('caps concurrent open transfers', () => {
    for (let i = 0; i < PATCH_MAX_OPEN; i++) {
      expect(frame(10 + i, `PATCH-BEGIN open-${i} 1 ${SHA}`)).toMatchObject({ outcome: 'consumed' });
    }
    expect(frame(99, `PATCH-BEGIN open-x 1 ${SHA}`)).toMatchObject({ outcome: 'refused' });
  });
});

describe('sweepPatchTransfers', () => {
  it('expires open transfers past the TTL and writes receipts', () => {
    const stale = new Date(NOW.getTime() - PATCH_TRANSFER_TTL_MS - 60_000);
    recordPatchFrame(msg(1, `PATCH-BEGIN old-1 2 ${SHA}`), { runsDir, now: () => stale });
    recordPatchFrame(msg(2, `PATCH-BEGIN new-1 2 ${SHA}`), { runsDir, now: () => NOW });
    expect(sweepPatchTransfers({ runsDir, now: () => NOW })).toMatchObject({ state: 'healthy', examined: 2, expired: 1, open: 1 });
    expect(receipt('old-1')).toMatchObject({ outcome: 'expired', sha256: SHA, parts: 2 });
    expect(existsSync(join(patches(), 'open', 'old-1.json'))).toBe(false);
    expect(existsSync(join(patches(), 'open', 'new-1.json'))).toBe(true);
    // The expired id is spent: a re-begin is refused, never resurrected.
    expect(recordPatchFrame(msg(3, `PATCH-BEGIN old-1 2 ${SHA}`), { runsDir, now: () => NOW })).toMatchObject({ outcome: 'refused' });
  });

  it('reports missing with no patches dir and rejects corrupt open files', () => {
    expect(sweepPatchTransfers({ runsDir })).toMatchObject({ state: 'missing', examined: 0, expired: 0 });
    recordPatchFrame(msg(1, `PATCH-BEGIN t-1 1 ${SHA}`), { runsDir, now: () => NOW });
    writeFileSync(join(patches(), 'open', 't-1.json'), '{torn');
    expect(sweepPatchTransfers({ runsDir, now: () => NOW })).toMatchObject({ state: 'healthy', expired: 1, open: 0 });
    expect(receipt('t-1')).toMatchObject({ outcome: 'rejected', reason: 'corrupt-state' });
  });
});

describe('ingestIMessages patch intake', () => {
  beforeEach(() => {
    mkdirSync(join(home, 'Library', 'Messages'), { recursive: true });
    writeFileSync(join(home, 'Library', 'Messages', 'chat.db'), '');
    writeCursor(10, runsDir, () => NOW);
  });

  it('consumes fixture chat.db frames, writes the artifact and announces it', async () => {
    const rows = [
      ...frames('fix-9', PATCH_BODY, 2).map((r, i) => ({ ...r, rowid: 11 + i })),
      row(15, 'the gate is red on lane work'),
    ];
    const result = await ingest(rows);
    expect(result).toMatchObject({ ok: true, state: 'ingested', scanned: 5, teammate: 5, cursor: 15 });
    expect(readCursor(runsDir)).toBe(15);

    // Artifact verified and written; the rowids are spent.
    expect(readFileSync(join(patches(), 'fix-9.patch'), 'utf8')).toBe(PATCH_BODY);
    expect(result.patches).toMatchObject({ state: 'healthy', frames: 4, completed: 1, rejected: 0, refused: 0, expired: 0 });

    // Frames are protocol traffic: the mirror skipped them (protocol count),
    // posted the finding row, and announced the verified artifact.
    expect(result.findings).toMatchObject({ state: 'healthy', posted: 1, protocol: 4, announced: 1, lastRowid: 15 });
    const envelopes = busEnvelopes();
    expect(envelopes.map((e) => e.id)).toEqual(['imessage-teammate-15', 'imessage-patch-fix-9']);
    expect(envelopes[1]).toMatchObject({ to: TEAMMATE_FINDINGS_TOPIC, channel: 'imessage', channel_ref: 'imessage:patches:fix-9', body: { kind: 'note', thread: senderIdFor(TEAMMATE) } });
    expect(envelopes[1]!.body).toMatchObject({ refs: [`imessage:patch:fix-9`, `queue:${TEAMMATE_FINDINGS_TOPIC}.patch-fix-9`] });
    // The notice carries metadata, never the patch body or the handle.
    expect(JSON.stringify(envelopes[1])).not.toContain('diff --git');
    expect(JSON.stringify(envelopes)).not.toContain(TEAMMATE);
  });

  it('does not mirror protocol frames as findings even when a transfer fails', async () => {
    const rows = [
      row(11, `PATCH-BEGIN fail-1 1 ${SHA}`),
      row(12, `PATCH-PART fail-1 1/1\n${PATCH_BODY}`),
      row(13, `PATCH-END fail-1 ${'0'.repeat(64)}`),
      row(14, 'a real finding'),
    ];
    const result = await ingest(rows);
    expect(result.patches).toMatchObject({ frames: 3, completed: 0, rejected: 1 });
    expect(result.findings).toMatchObject({ posted: 1, protocol: 3, announced: 0 });
    expect(busEnvelopes().map((e) => e.id)).toEqual(['imessage-teammate-14']);
    expect(receipt('fail-1')).toMatchObject({ outcome: 'rejected', reason: 'hash-mismatch' });
  });

  it('is idempotent when the same rows are re-polled', async () => {
    const rows = frames('fix-10', PATCH_BODY, 2).map((r, i) => ({ ...r, rowid: 11 + i }));
    expect((await ingest(rows)).patches).toMatchObject({ frames: 4, completed: 1 });
    // Simulate a cursor rewind: the same rows replay and dedupe by rowid.
    writeCursor(10, runsDir, () => NOW);
    const replay = await ingest(rows);
    expect(replay.patches).toMatchObject({ frames: 4, duplicate: 4, completed: 0 });
    expect(replay.findings).toMatchObject({ posted: 0, announced: 0 });
    expect(busEnvelopes().map((e) => e.id)).toEqual(['imessage-patch-fix-10']);
    expect(readFileSync(join(patches(), 'fix-10.patch'), 'utf8')).toBe(PATCH_BODY);
  });

  it('keeps a completed patch announced even with an empty later poll', async () => {
    await ingest(frames('fix-11', PATCH_BODY, 2).map((r, i) => ({ ...r, rowid: 11 + i })));
    expect((await ingest([])).findings).toMatchObject({ examined: 0, announced: 0 });
    expect(busEnvelopes().map((e) => e.id)).toEqual(['imessage-patch-fix-11']);
  });
});

describe('bridgeTeammateFindings patch announcements', () => {
  it('marks expired receipts announced-past so no pass rescans them', () => {
    const stale = new Date(NOW.getTime() - 8 * 24 * 60 * 60_000);
    recordPatchFrame(msg(1, `PATCH-BEGIN dead-1 1 ${SHA}`), { runsDir, now: () => stale });
    recordPatchFrame(msg(2, `PATCH-PART dead-1 1/1\n${PATCH_BODY}`), { runsDir, now: () => stale });
    recordPatchFrame(msg(3, `PATCH-END dead-1 ${SHA}`), { runsDir, now: () => stale });
    expect(receipt('dead-1')).toMatchObject({ outcome: 'verified' });
    expect(bridge()).toMatchObject({ announced: 0 });
    expect(busEnvelopes()).toHaveLength(0);
    // Second pass: the receipt is behind the announced ring, never rescanned.
    expect(bridge()).toMatchObject({ announced: 0 });
  });

  it('announces verified receipts and skips rejected or expired ones', () => {
    for (const r of frames('good-1', PATCH_BODY, 1)) recordPatchFrame(r, { runsDir, now: () => NOW });
    recordPatchFrame(msg(10, `PATCH-BEGIN rej-1 1 ${SHA}`), { runsDir, now: () => NOW });
    recordPatchFrame(msg(11, `PATCH-END rej-1 ${'0'.repeat(64)}`), { runsDir, now: () => NOW });
    expect(bridge()).toMatchObject({ announced: 1 });
    const envelopes = busEnvelopes();
    expect(envelopes.map((e) => e.id)).toEqual(['imessage-patch-good-1']);
    expect(receipt('rej-1')).toMatchObject({ outcome: 'rejected' });
  });
});
