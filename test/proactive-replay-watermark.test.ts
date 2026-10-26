/** Real isolated private-store custody tests; no provider calls or user-home data. */
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReplayWatermark, reserveReplayWatermark } from '../src/core/proactive/replay-watermark.js';

let directory: string;
const limits = { maxRecords: 16 }, first = 'a'.repeat(64), second = 'b'.repeat(64);
const one = { revision: 1, ledgerDigest: first, previousLedgerDigest: null };
const two = { revision: 2, ledgerDigest: second, previousLedgerDigest: first };
const custody = () => join(directory, 'replay-watermarks');
const file = (revision: number) => join(custody(), 'records', `${String(revision).padStart(16, '0')}.json`);
beforeEach(() => { directory = mkdtempSync(join(realpathSync(tmpdir()), 'phantom-replay-watermark-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('independent local replay watermark custody', { timeout: 15_000 }, () => {
  it('reads missing custody without creating storage and reserves a durable independent head before ledger publication', () => {
    expect(readReplayWatermark(directory, limits)).toEqual({ sourceState: 'missing', revision: 0, ledgerDigest: null });
    expect(readdirSync(directory)).toEqual([]);
    expect(reserveReplayWatermark(directory, one, limits)).toBe('recorded');
    expect(readdirSync(directory)).toEqual(['replay-watermarks']);
    expect(readReplayWatermark(directory, limits)).toEqual({ sourceState: 'healthy', revision: 1, ledgerDigest: first });
    // No ledger exists: callers must hold this reserved-but-unpublished state, not replay it as an empty ledger.
    expect(readdirSync(directory).includes('ledger')).toBe(false);
    if (process.platform !== 'win32') {
      for (const path of [custody(), join(custody(), 'records'), join(custody(), 'staging')]) expect(statSync(path).mode & 0o777).toBe(0o700);
      expect(statSync(file(1)).mode & 0o777).toBe(0o600);
    }
  });
  it('replays only the exact latest reservation and refuses older prefixes, skipped revisions and head replacement', () => {
    expect(reserveReplayWatermark(directory, one, limits)).toBe('recorded');
    const original = readFileSync(file(1), 'utf8');
    expect(reserveReplayWatermark(directory, one, limits)).toBe('replayed'); expect(readFileSync(file(1), 'utf8')).toBe(original);
    expect(reserveReplayWatermark(directory, two, limits)).toBe('recorded');
    const current = readFileSync(file(2), 'utf8');
    expect(reserveReplayWatermark(directory, one, limits)).toBe('conflict');
    expect(reserveReplayWatermark(directory, { ...two, ledgerDigest: 'c'.repeat(64) }, limits)).toBe('conflict');
    expect(reserveReplayWatermark(directory, { revision: 4, ledgerDigest: first, previousLedgerDigest: second }, limits)).toBe('conflict');
    expect(reserveReplayWatermark(directory, { revision: 3, ledgerDigest: first, previousLedgerDigest: null }, limits)).toBe('conflict');
    expect(readFileSync(file(2), 'utf8')).toBe(current);
    expect(readReplayWatermark(directory, limits)).toEqual({ sourceState: 'healthy', revision: 2, ledgerDigest: second });
  });
  it('retains the latest head when ledger records or the entire ledger are deleted', () => {
    const ledger = join(directory, 'ledger'); mkdirSync(ledger, { mode: 0o700 });
    expect(reserveReplayWatermark(directory, one, limits)).toBe('recorded'); writeFileSync(join(ledger, '1.json'), first, { mode: 0o600 });
    expect(reserveReplayWatermark(directory, two, limits)).toBe('recorded'); writeFileSync(join(ledger, '2.json'), second, { mode: 0o600 });
    unlinkSync(join(ledger, '2.json'));
    expect(readReplayWatermark(directory, limits)).toEqual({ sourceState: 'healthy', revision: 2, ledgerDigest: second });
    expect(readFileSync(join(ledger, '1.json'), 'utf8')).toBe(first);
    rmSync(ledger, { recursive: true });
    expect(readReplayWatermark(directory, limits)).toEqual({ sourceState: 'healthy', revision: 2, ledgerDigest: second });
  });
  it('reports missing custody after its deletion without silently recreating it on reads', () => {
    expect(reserveReplayWatermark(directory, one, limits)).toBe('recorded');
    rmSync(custody(), { recursive: true });
    expect(readReplayWatermark(directory, limits)).toEqual({ sourceState: 'missing', revision: 0, ledgerDigest: null });
    expect(readdirSync(directory)).toEqual([]);
    // The containing ledger must reject missing custody with nonempty history; whole custody removal is not external tamper protection.
  });
  it('withholds a corrupt, gapped or semantically disconnected complete watermark chain', () => {
    expect(reserveReplayWatermark(directory, one, limits)).toBe('recorded'); expect(reserveReplayWatermark(directory, two, limits)).toBe('recorded');
    const original = readFileSync(file(2), 'utf8');
    writeFileSync(file(2), '{corrupt\n');
    expect(readReplayWatermark(directory, limits).sourceState).toBe('degraded');
    expect(reserveReplayWatermark(directory, { revision: 3, ledgerDigest: first, previousLedgerDigest: second }, limits)).toBe('unavailable');
    expect(readFileSync(file(2), 'utf8')).toBe('{corrupt\n');
    writeFileSync(file(2), original);
    const payload = { schemaVersion: 1, revision: 2, ledgerDigest: second, previousLedgerDigest: 'c'.repeat(64),
      previousWatermarkDigest: JSON.parse(original).previousWatermarkDigest };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    writeFileSync(file(2), `${JSON.stringify({ ...payload, digest })}\n`);
    expect(readReplayWatermark(directory, limits).sourceState).toBe('degraded');
    writeFileSync(file(2), original); unlinkSync(file(1));
    expect(readReplayWatermark(directory, limits).sourceState).toBe('degraded');
  });
  it('keeps incomplete publication artifacts degraded and never recovers or publishes them automatically', () => {
    expect(reserveReplayWatermark(directory, one, limits)).toBe('recorded');
    const stage = join(custody(), 'staging', '.orphan.stage');
    writeFileSync(stage, readFileSync(file(1)), { mode: 0o600 });
    expect(readReplayWatermark(directory, limits).sourceState).toBe('degraded');
    expect(reserveReplayWatermark(directory, two, limits)).toBe('unavailable');
    expect(readFileSync(stage, 'utf8')).toBe(readFileSync(file(1), 'utf8'));
    expect(readdirSync(join(custody(), 'records'))).toHaveLength(1);
  });
  it('bounds complete reads and reservations and refuses invalid digest/limits without creating storage', () => {
    expect(reserveReplayWatermark(directory, { ...one, ledgerDigest: 'bad' }, limits)).toBe('unavailable');
    expect(reserveReplayWatermark(directory, one, { maxRecords: 0 })).toBe('unavailable');
    expect(reserveReplayWatermark(directory, one, { maxRecords: 1, maxBytes: 10 })).toBe('unavailable');
    expect(readdirSync(directory)).toEqual([]);
    expect(reserveReplayWatermark(directory, one, { maxRecords: 1 })).toBe('recorded');
    expect(reserveReplayWatermark(directory, two, { maxRecords: 1 })).toBe('unavailable');
    expect(readReplayWatermark(directory, { maxRecords: 16, maxBytes: 10 }).sourceState).toBe('degraded');
    expect(reserveReplayWatermark(directory, two, limits)).toBe('recorded');
    expect(readReplayWatermark(directory, { maxRecords: 1 }).sourceState).toBe('degraded');
    expect(readReplayWatermark(directory, { maxRecords: 0 }).sourceState).toBe('degraded');
  });
  it('refuses symlinked, public or multiply linked custody without altering the existing target', () => {
    expect(reserveReplayWatermark(directory, one, limits)).toBe('recorded');
    const original = readFileSync(file(1), 'utf8'), outside = join(directory, 'outside');
    writeFileSync(outside, original, { mode: 0o600 });
    unlinkSync(file(1)); symlinkSync(outside, file(1));
    expect(readReplayWatermark(directory, limits).sourceState).toBe('degraded'); expect(reserveReplayWatermark(directory, two, limits)).toBe('unavailable');
    expect(readFileSync(outside, 'utf8')).toBe(original);
    unlinkSync(file(1)); linkSync(outside, file(1));
    expect(readReplayWatermark(directory, limits).sourceState).toBe('degraded');
    unlinkSync(file(1)); writeFileSync(file(1), original, { mode: 0o600 });
    if (process.platform !== 'win32') {
      chmodSync(custody(), 0o755); expect(readReplayWatermark(directory, limits).sourceState).toBe('degraded');
      expect(reserveReplayWatermark(directory, two, limits)).toBe('unavailable');
    }
  });
});
