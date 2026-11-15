/**
 * RQ-PHX-PATCHARTIFACT131: recovered bounded iMessage patch-transfer artifact
 * module (original PR #4966). Synthetic tmp dirs, fake handles; nothing sends
 * a message, reads a real inbox, or applies a patch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = new Date('2026-11-11T12:00:00Z');
const DOT = 'dot@example.test';
const EVIL = 'evil@example.test';
const BODY = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'.repeat(4);
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

let runsDir = '';
const patches = () => join(runsDir, 'imessage', 'patches');
const load = async () => {
  vi.resetModules(); // simulate a process restart: no in-memory state may matter
  return import('../src/core/comms/imessage-patch-transfer.js');
};
type Mod = Awaited<ReturnType<typeof load>>;

let rowid = 0;
const send = (m: Mod, text: string, handle = DOT, now = NOW) =>
  m.recordPatchFrame({ rowid: ++rowid, handle, text }, { runsDir, now: () => now });
const chunks = (payload: string, n: number): string[] => {
  const size = Math.ceil(payload.length / n);
  return Array.from({ length: n }, (_, i) => payload.slice(i * size, (i + 1) * size));
};
const part = (id: string, i: number, n: number, c: string) => `PATCH-PART ${id} ${i}/${n}\n${c}`;
const artifacts = () => existsSync(patches()) ? readdirSync(patches()).filter((f) => f.endsWith('.patch')) : [];

beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'patch-artifact-131-')); rowid = 0; });
afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

describe('recovered patch transfer artifact', () => {
  it('reconstructs out-of-order parts across restarts into exactly one verified private artifact', async () => {
    const cs = chunks(BODY, 4);
    const digest = sha(BODY);
    let m = await load(); // process 1
    expect(send(m, `PATCH-BEGIN p1 4 ${digest}`).outcome).toBe('consumed');
    for (const i of [3, 1]) expect(send(m, part('p1', i, 4, cs[i - 1]!)).outcome).toBe('consumed');
    m = await load(); // restart 2
    expect(send(m, `PATCH-END p1 ${digest}`).outcome).toBe('consumed');
    expect(artifacts()).toEqual([]);
    expect(send(m, part('p1', 4, 4, cs[3]!)).outcome).toBe('consumed');
    m = await load(); // restart 3
    expect(send(m, part('p1', 2, 4, cs[1]!)).outcome).toBe('completed');

    expect(artifacts()).toEqual(['p1.patch']);
    const file = join(patches(), 'p1.patch');
    expect(sha(readFileSync(file, 'utf8'))).toBe(digest);
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(statSync(join(patches(), 'p1.receipt.json')).mode & 0o077).toBe(0);
    const { receipts } = m.readPatchReceipts({ runsDir });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ id: 'p1', outcome: 'verified', sha256: digest, parts: 4 });
    expect(JSON.stringify(receipts)).not.toContain(DOT);
    expect(readdirSync(join(patches(), 'open'))).toEqual([]);
  }, 60_000);

  it('is idempotent on replay: duplicate rowids and a reused id never rewrite the artifact', async () => {
    const digest = sha(BODY);
    const m = await load();
    const frames = [`PATCH-BEGIN r1 1 ${digest}`, part('r1', 1, 1, BODY), `PATCH-END r1 ${digest}`];
    for (const f of frames) m.recordPatchFrame({ rowid: ++rowid, handle: DOT, text: f }, { runsDir, now: () => NOW });
    const before = readFileSync(join(patches(), 'r1.patch'), 'utf8');
    for (let r = 1; r <= 3; r++) {
      expect(m.recordPatchFrame({ rowid: r, handle: DOT, text: frames[r - 1]! }, { runsDir, now: () => NOW }).outcome).toBe('duplicate');
    }
    // A fresh rowid replaying the same id after completion is refused (spent).
    expect(send(m, `PATCH-BEGIN r1 1 ${digest}`).outcome).toBe('refused');
    expect(readFileSync(join(patches(), 'r1.patch'), 'utf8')).toBe(before);
    expect(artifacts()).toEqual(['r1.patch']);
  }, 60_000);

  it('wrong sender cannot contribute to or complete a transfer', async () => {
    const m = await load();
    const digest = sha(BODY);
    send(m, `PATCH-BEGIN s1 1 ${digest}`);
    expect(send(m, part('s1', 1, 1, BODY), EVIL).outcome).toBe('rejected');
    expect(send(m, `PATCH-END s1 ${digest}`).outcome).toBe('refused'); // id spent
    expect(artifacts()).toEqual([]);
    expect(m.readPatchReceipts({ runsDir }).receipts[0]).toMatchObject({ id: 's1', outcome: 'rejected', reason: 'conflict' });
  }, 60_000);

  it('malformed frames never verify', async () => {
    const m = await load();
    const digest = sha(BODY);
    for (const bad of ['PATCH-BEGIN ../x 1 ' + digest, 'PATCH-BEGIN m1 0 ' + digest, 'PATCH-BEGIN m1 65 ' + digest,
      'PATCH-BEGIN m1 1 xyz', 'PATCH-PART m1 2/1\nx', 'PATCH-PART m1 1/1', 'PATCH-END m1']) {
      expect(m.parsePatchFrame(bad)).toBe('malformed');
      expect(send(m, bad).outcome).toBe('refused');
    }
    expect(m.parsePatchFrame('hello there')).toBeNull();
    expect(artifacts()).toEqual([]);
  }, 60_000);

  it('oversize payloads are rejected', async () => {
    const m = await load();
    const big = 'x'.repeat(16_000);
    send(m, `PATCH-BEGIN o1 64 ${sha('z')}`);
    let last = '';
    for (let i = 1; i <= 64 && last !== 'rejected'; i++) last = send(m, part('o1', i, 64, big)).outcome;
    expect(last).toBe('rejected');
    expect(m.readPatchReceipts({ runsDir }).receipts[0]).toMatchObject({ id: 'o1', outcome: 'rejected', reason: 'oversize' });
    expect(send(m, `PATCH-PART o2 1/1\n${'y'.repeat(m.PATCH_FRAME_MAX)}`).outcome).toBe('refused');
    expect(artifacts()).toEqual([]);
  }, 60_000);

  it('wrong digest cannot produce a verified artifact', async () => {
    const m = await load();
    send(m, `PATCH-BEGIN d1 1 ${sha('different')}`);
    send(m, part('d1', 1, 1, BODY));
    expect(send(m, `PATCH-END d1 ${sha('different')}`).outcome).toBe('rejected');
    send(m, `PATCH-BEGIN d2 1 ${sha(BODY)}`);
    expect(send(m, `PATCH-END d2 ${sha('other')}`).outcome).toBe('rejected');
    expect(artifacts()).toEqual([]);
    expect(m.readPatchReceipts({ runsDir }).receipts.map((r) => r.reason)).toEqual(['hash-mismatch', 'hash-mismatch']);
  }, 60_000);

  it('expires stale transfers and never completes them afterwards', async () => {
    const m = await load();
    send(m, `PATCH-BEGIN e1 2 ${sha(BODY)}`);
    const later = new Date(NOW.getTime() + m.PATCH_TRANSFER_TTL_MS + 1000);
    expect(m.sweepPatchTransfers({ runsDir, now: () => later })).toMatchObject({ state: 'healthy', expired: 1, open: 0 });
    expect(send(m, part('e1', 1, 2, BODY), DOT, later).outcome).toBe('refused');
    expect(artifacts()).toEqual([]);
    expect(m.readPatchReceipts({ runsDir }).receipts[0]).toMatchObject({ id: 'e1', outcome: 'expired' });
  }, 60_000);

  it('does not treat secret-shaped chunks as storable', async () => {
    const m = await load();
    send(m, `PATCH-BEGIN k1 1 ${sha(BODY)}`);
    expect(send(m, part('k1', 1, 1, 'sk-ant-api03-' + 'A'.repeat(40))).outcome).toBe('refused');
    expect(artifacts()).toEqual([]);
  }, 60_000);
});
