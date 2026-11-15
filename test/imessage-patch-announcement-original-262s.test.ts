/**
 * RQ-PHX-PATCHANNOUNCEORIGINAL262S: restart/retry proof for the durable
 * patch-to-bus announcement path recovered from original PR #4073
 * (RQ-SWE3-IMSGDEEP-1), serving Mason's Nov 5 accumulated-original-PR
 * preservation and Nov 12 receipt-backed coordination orders.
 *
 * The gap this pins: every existing suite proves the announcement posts and
 * dedupes on a healthy store, but none proves an agent recovers a verified
 * incoming patch announcement after a transient bus failure without losing
 * or duplicating its durable artifact. This file drives the real sequence:
 *
 *   1. recordPatchFrame (real) reassembles BEGIN/PART/END into a verified
 *      artifact + receipt on disk; recordTeammateText mirrors the same rows
 *      exactly as intake does, so the bridge sees real protocol rows.
 *   2. bridgeTeammateFindings (real) runs with its append seam returning a
 *      real supported transient post status once — 'retryable', the status
 *      appendBusInbox itself returns when the writer lock is contended.
 *   3. The verified artifact and receipt survive, no announcement is
 *      recorded, and the announcedPatchIds ring stays empty.
 *   4. After vi.resetModules (a process restart — no in-memory state may
 *      matter), a pass against the REAL bus store announces exactly once.
 *   5. A third pass proves dedupe; the recovered envelope references the
 *      verified artifact and carries no raw handle or patch payload.
 *
 * Hermetic: runsDir and the bus root are tmp dirs, the handle is a placeholder,
 * nothing reaches chat.db, a model or a transport, and asserts never print
 * message text or handles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = new Date('2026-11-13T12:00:00Z');
const DOT = '+15550000177';
const TRANSFER = 'orig262-1';
const PAYLOAD = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
const SHA = createHash('sha256').update(PAYLOAD, 'utf8').digest('hex');

let runsDir = '';
let busRoot = '';

const imsgDir = () => join(runsDir, 'imessage');
const patchesDir = () => join(imsgDir(), 'patches');
const artifactPath = () => join(patchesDir(), `${TRANSFER}.patch`);
const receiptPath = () => join(patchesDir(), `${TRANSFER}.receipt.json`);
const watermarkPath = () => join(imsgDir(), 'findings-bridge.json');

const load = async () => {
  vi.resetModules(); // simulate a process restart: recovery must come from disk
  const [transfer, findings, inbox, bus] = await Promise.all([
    import('../src/core/comms/imessage-patch-transfer.js'),
    import('../src/core/comms/imessage-findings-bridge.js'),
    import('../src/core/comms/imessage-teammate-inbox.js'),
    import('../src/core/fleet/bus-inbox.js'),
  ]);
  return { transfer, findings, inbox, bus };
};

const busEnvelopes = async () => {
  const { bus } = await load();
  const page = bus.listBusInboxAfter(0, 100, { root: busRoot });
  return page.status === 'ok' ? page.messages.map((m) => m.envelope) : [];
};

const watermark = (): { lastRowid: number; announcedPatchIds: string[] } =>
  JSON.parse(readFileSync(watermarkPath(), 'utf8')) as { lastRowid: number; announcedPatchIds: string[] };

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'patch-announce-262s-runs-'));
  busRoot = mkdtempSync(join(tmpdir(), 'patch-announce-262s-bus-'));
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(busRoot, { recursive: true, force: true });
});

describe('patch announcement survives a transient bus failure across restarts', () => {
  it('recovers the verified artifact announcement exactly once through the real store', async () => {
    // --- Durable intake: the same rows real ingest receipts, in order. ---
    let m = await load();
    const frames = [
      `PATCH-BEGIN ${TRANSFER} 1 ${SHA}`,
      `PATCH-PART ${TRANSFER} 1/1\n${PAYLOAD}`,
      `PATCH-END ${TRANSFER} ${SHA}`,
    ];
    const outcomes: string[] = [];
    for (const [index, text] of frames.entries()) {
      const rowid = index + 1;
      // Intake receipts the teammate row first, then consumes the frame —
      // the bridge must see protocol rows, never findings.
      expect(m.inbox.recordTeammateText({ rowid, handle: DOT, text }, runsDir, NOW)).toBe(true);
      const frame = m.transfer.recordPatchFrame({ rowid, handle: DOT, text }, { runsDir, now: () => NOW });
      expect(frame.handled).toBe(true);
      outcomes.push(frame.outcome);
    }
    expect(outcomes).toEqual(['consumed', 'consumed', 'completed']);

    // The verified artifact and its receipt are durable private evidence.
    expect(readFileSync(artifactPath(), 'utf8')).toBe(PAYLOAD);
    expect(statSync(artifactPath()).mode & 0o777).toBe(0o600);
    const storedReceipt = JSON.parse(readFileSync(receiptPath(), 'utf8')) as { outcome: string; id: string; sha256: string };
    expect(storedReceipt).toMatchObject({ id: TRANSFER, outcome: 'verified', sha256: SHA });
    expect(statSync(receiptPath()).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(storedReceipt)).not.toContain(DOT);

    // --- Pass 1: the bus append seam fails transiently, once per call. ---
    // 'retryable' is a real BusInboxPost status: appendBusInbox returns it
    // when the bus-inbox writer lock is contended. The bridge must leave the
    // announcement pending rather than mark it announced.
    m = await load();
    const failingAppend = vi.fn(() => ({ status: 'retryable' as const }));
    const first = m.findings.bridgeTeammateFindings({
      runsDir, busRoot, now: () => NOW, append: failingAppend,
    });
    expect(first).toMatchObject({ state: 'pending', protocol: 3, posted: 0, announced: 0, pending: 1, lastRowid: 3 });
    expect(failingAppend).toHaveBeenCalledTimes(1);

    // Durable evidence survives the failed pass; nothing was announced.
    expect(readFileSync(artifactPath(), 'utf8')).toBe(PAYLOAD);
    expect(JSON.parse(readFileSync(receiptPath(), 'utf8'))).toMatchObject({ outcome: 'verified' });
    expect(watermark().announcedPatchIds).not.toContain(TRANSFER);
    expect(await busEnvelopes()).toHaveLength(0);

    // --- Pass 2 (post-restart, real bus store): announces exactly once. ---
    m = await load();
    const second = m.findings.bridgeTeammateFindings({ runsDir, busRoot, now: () => NOW });
    expect(second).toMatchObject({ state: 'healthy', announced: 1, pending: 0, lastRowid: 3 });

    const envelopes = await busEnvelopes();
    expect(envelopes.map((e) => e.id)).toEqual([`imessage-patch-${TRANSFER}`]);
    const envelope = envelopes[0]!;
    expect(envelope).toMatchObject({
      to: m.findings.TEAMMATE_FINDINGS_TOPIC,
      channel: 'imessage',
      channel_ref: `imessage:patches:${TRANSFER}`,
      external: false,
      body: { kind: 'note' },
    });
    expect(envelope.from).toMatch(/^imessage:[a-f0-9]{16}$/);
    // The recovered announcement references the verified artifact and its
    // receipt-derived identity — metadata only, never the payload or handle.
    expect(envelope.body.kind === 'note' && envelope.body.text).toContain(`imessage/patches/${TRANSFER}.patch`);
    expect(envelope.body.kind === 'note' && envelope.body.text).toContain(SHA.slice(0, 16));
    expect(envelope.body.kind === 'note' && envelope.body.refs).toContain(`imessage:patch:${TRANSFER}`);
    const wire = JSON.stringify(envelope);
    expect(wire).not.toContain(DOT);
    expect(wire).not.toContain(PAYLOAD);
    expect(wire).not.toContain('diff --git');

    // --- Pass 3 (another restart): the announced ring dedupes forever. ---
    m = await load();
    const third = m.findings.bridgeTeammateFindings({ runsDir, busRoot, now: () => NOW });
    expect(third).toMatchObject({ announced: 0, pending: 0 });
    expect(await busEnvelopes()).toHaveLength(1);
    expect(watermark().announcedPatchIds).toContain(TRANSFER);
    expect(existsSync(artifactPath())).toBe(true);
  }, 60_000);
});
