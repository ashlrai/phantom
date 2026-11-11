/**
 * RQ-PHX-RECUTCOMMSO1S126 recut coverage for #4073 (RQ-SWE3-IMSGDEEP-1) on
 * current master. The carried test (imessage-patch-transfer.test.ts) covers
 * the protocol and the ingest pipeline; this file pins what the recut itself
 * had to merge differently:
 *
 *   - Frame recognition uses the current transfer module public export.
 *   - The findings watermark keeps master's hardened fail-closed read while
 *     carrying the announcedPatchIds ring, and stays backward compatible with
 *     pre-patch watermarks that never had the field.
 *   - ingestIMessages reports `patches` on every exit path, including polls
 *     that fail before any row is ingested.
 *
 * Hermetic: node:child_process is mocked, HOME/runsDir/bus roots are tmp dirs,
 * handles are placeholders, and asserts never print message text or handles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

import { classifyTeammateIntent, senderIdFor, teammateNeedsReply } from '../src/core/comms/imessage-teammate-inbox.js';
import { isPatchFrameText, recordPatchFrame, type PatchReceipt } from '../src/core/comms/imessage-patch-transfer.js';
import { bridgeTeammateFindings, TEAMMATE_FINDINGS_TOPIC } from '../src/core/comms/imessage-findings-bridge.js';
import * as findingsModule from '../src/core/comms/imessage-findings-bridge.js';
import { ingestIMessages } from '../src/core/comms/imessage-inbox-bridge.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { writeCursor, type IntakeMsg } from '../src/core/integrations/imessage.js';
import type { AshlrConfig } from '../src/core/types.js';

const MASON = 'mason@example.test';
const TEAMMATE = 'teammate@example.test';
const NOW = new Date('2026-11-10T12:00:00Z');
const BODY = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
const SHA = createHash('sha256').update(BODY, 'utf8').digest('hex');

const cfg = (): AshlrConfig =>
  ({ comms: { enabled: true, imessageHandle: MASON, imessageAllow: [MASON, TEAMMATE] } }) as AshlrConfig;
const row = (rowid: number, text: string, handle = TEAMMATE): IntakeMsg => ({ rowid, handle, text, ts: 1 });

let home = '';
let runsDir = '';
let busRoot = '';
let previousHome: string | undefined;

const imsgDir = () => join(runsDir, 'imessage');
const watermarkPath = () => join(imsgDir(), 'findings-bridge.json');
const busEnvelopes = () => {
  const page = listBusInboxAfter(0, 100, { root: busRoot });
  return page.status === 'ok' ? page.messages.map((m) => m.envelope) : [];
};

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'imsg-recut-home-'));
  runsDir = mkdtempSync(join(tmpdir(), 'imsg-recut-runs-'));
  busRoot = mkdtempSync(join(tmpdir(), 'imsg-recut-bus-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(busRoot, { recursive: true, force: true });
});

describe('patch frame recognition', () => {
  it('recognizes protocol markers through the transfer module public export', () => {
    expect(isPatchFrameText('PATCH-BEGIN x 1 ' + '0'.repeat(64))).toBe(true);
    expect(isPatchFrameText('PATCH-PART x 1/2\nc')).toBe(true);
    expect(isPatchFrameText('PATCH-FOO x')).toBe(false);
  });

  it('the intent classifier treats frames as protocol, never conversation', () => {
    expect(teammateNeedsReply(`PATCH-BEGIN t 1 ${SHA}`)).toBe(false);
    expect(teammateNeedsReply('PATCH-PART t 1/1\npayload')).toBe(false);
    expect(teammateNeedsReply('PATCH-END t ' + '0'.repeat(64))).toBe(false);
    expect(classifyTeammateIntent(`PATCH-BEGIN t 1 ${SHA}`)).toBe('ignore');
    // Ordinary requests still classify the same.
    expect(teammateNeedsReply('can you check the gate?')).toBe(true);
  });
});

const teammatePatchEnvelope = (findingsModule as unknown as { teammatePatchEnvelope: (receipt: PatchReceipt) => unknown }).teammatePatchEnvelope;

describe('teammatePatchEnvelope', () => {
  const receipt = (over: Partial<PatchReceipt> = {}): PatchReceipt =>
    ({ v: 1, id: 'fix-1', outcome: 'verified', sha256: SHA, parts: 2, bytes: 44, rowids: [1], senderId: senderIdFor(TEAMMATE), completedAt: NOW.toISOString(), ...over });

  it('maps a verified receipt to a metadata-only note', () => {
    const env = teammatePatchEnvelope(receipt());
    expect(env).toMatchObject({
      id: 'imessage-patch-fix-1', from: senderIdFor(TEAMMATE), to: TEAMMATE_FINDINGS_TOPIC,
      channel: 'imessage', channel_ref: 'imessage:patches:fix-1', external: false,
      body: { kind: 'note', thread: senderIdFor(TEAMMATE) },
    });
    expect(JSON.stringify(env)).not.toContain(TEAMMATE);
    expect(JSON.stringify(env)).not.toContain('diff --git');
  });

  it('refuses non-verified and malformed receipts', () => {
    expect(teammatePatchEnvelope(receipt({ outcome: 'rejected' }))).toBeNull();
    expect(teammatePatchEnvelope(receipt({ outcome: 'expired' }))).toBeNull();
    expect(teammatePatchEnvelope(receipt({ id: '../escape' }))).toBeNull();
    expect(teammatePatchEnvelope(receipt({ sha256: 'zz' }))).toBeNull();
  });
});

describe('findings watermark on the hardened read', () => {
  it('accepts a pre-patch watermark with no announcedPatchIds field', () => {
    mkdirSync(imsgDir(), { recursive: true });
    writeFileSync(watermarkPath(), JSON.stringify({ v: 1, lastRowid: 40, at: NOW.toISOString() }), { mode: 0o600 });
    const report = bridgeTeammateFindings({ runsDir, busRoot, now: () => NOW });
    expect(report.state).not.toBe('unavailable');
    expect(report.lastRowid).toBe(40);
  });

  it('fails closed on a corrupt announcedPatchIds ring, never a silent reset', () => {
    mkdirSync(imsgDir(), { recursive: true });
    writeFileSync(watermarkPath(), JSON.stringify({ v: 1, lastRowid: 40, announcedPatchIds: [42] }), { mode: 0o600 });
    expect(bridgeTeammateFindings({ runsDir, busRoot, now: () => NOW }).state).toBe('unavailable');
    // A corrupt regular watermark file is corrupt, not a fresh start.
    writeFileSync(watermarkPath(), '{torn', { mode: 0o600 });
    expect(bridgeTeammateFindings({ runsDir, busRoot, now: () => NOW }).state).toBe('unavailable');
  });

  it('persists announcedPatchIds so a receipt is announced exactly once', () => {
    recordPatchFrame({ rowid: 1, handle: TEAMMATE, text: `PATCH-BEGIN once-1 1 ${SHA}` }, { runsDir, now: () => NOW });
    recordPatchFrame({ rowid: 2, handle: TEAMMATE, text: `PATCH-PART once-1 1/1\n${BODY}` }, { runsDir, now: () => NOW });
    recordPatchFrame({ rowid: 3, handle: TEAMMATE, text: `PATCH-END once-1 ${SHA}` }, { runsDir, now: () => NOW });
    expect(bridgeTeammateFindings({ runsDir, busRoot, now: () => NOW })).toMatchObject({ announced: 1 });
    const stored = JSON.parse(readFileSync(watermarkPath(), 'utf8')) as { announcedPatchIds?: string[] };
    expect(stored.announcedPatchIds).toContain('once-1');
    expect(bridgeTeammateFindings({ runsDir, busRoot, now: () => NOW })).toMatchObject({ announced: 0 });
    expect(busEnvelopes().map((e) => e.id)).toEqual(['imessage-patch-once-1']);
  });
});

describe('ingestIMessages patch tallies on every exit path', () => {
  beforeEach(() => {
    mkdirSync(join(home, 'Library', 'Messages'), { recursive: true });
    writeFileSync(join(home, 'Library', 'Messages', 'chat.db'), '');
    writeCursor(10, runsDir, () => NOW);
  });

  it('runs the sweep even when the poll fails before any row', async () => {
    const stale = new Date(NOW.getTime() - 7 * 60 * 60 * 1000);
    recordPatchFrame({ rowid: 5, handle: TEAMMATE, text: `PATCH-BEGIN stuck-1 2 ${SHA}` }, { runsDir, now: () => stale });
    const result = await ingestIMessages(cfg(), {
      runsDir, busRoot, now: () => NOW, platform: 'darwin',
      poll: async () => ({ ok: false, state: 'error' }),
    });
    expect(result.state).toBe('error');
    expect((result as typeof result & { patches?: unknown }).patches).toMatchObject({ state: 'healthy', expired: 1, open: 0 });
    expect(JSON.parse(readFileSync(join(imsgDir(), 'patches', 'stuck-1.receipt.json'), 'utf8'))).toMatchObject({ outcome: 'expired' });
  });

  it('reports frame tallies and keeps frames out of teammates findings', async () => {
    const result = await ingestIMessages(cfg(), {
      runsDir, busRoot, now: () => NOW, platform: 'darwin',
      poll: async () => ({
        ok: true,
        messages: [
          row(11, `PATCH-BEGIN done-1 1 ${SHA}`),
          row(12, `PATCH-PART done-1 1/1\n${BODY}`),
          row(13, `PATCH-END done-1 ${SHA}`),
        ],
      }),
    });
    expect(result).toMatchObject({ ok: true, state: 'ingested', teammate: 3 });
    expect((result as typeof result & { patches?: unknown }).patches).toMatchObject({ frames: 3, completed: 1 });
    expect(result.findings).toMatchObject({ protocol: 3, posted: 0, announced: 1 });
    expect(existsSync(join(imsgDir(), 'patches', 'done-1.patch'))).toBe(true);
  });
});
