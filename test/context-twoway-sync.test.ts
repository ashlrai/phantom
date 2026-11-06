import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcile, type SyncRecord, type SyncField, type SyncValue } from '../src/core/context/twoway-sync.js';
import { fileSyncAdapter } from '../src/core/context/twoway-file-adapter.js';
const cell = (value: SyncValue, origin = 'local', day = 1): SyncField => ({ value, origin, updated_at: `2026-11-0${day}T00:00:00Z` });
const record = (fields: Record<string, SyncField>): SyncRecord => ({ id: 'company', kind: 'company-context', origin: 'local', updated_at: cell(null).updated_at, fields });
describe('two-way context sync', () => {
  it('merges independent concurrent edits and retains competing last writers', () => {
    const base = record({ a: cell(0), b: cell(0) });
    const left = record({ a: cell(1), b: cell(0) });
    const right = record({ a: cell(0), b: cell(2, 'github', 2) });
    expect(reconcile(left, right, base).record.fields).toEqual({ a: cell(1), b: cell(2, 'github', 2) });
    const result = reconcile(left, record({ a: cell(3, 'supabase', 3) }), base);
    expect(result.record.fields.a?.value).toBe(3);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.resolution).toBe('last-writer');
  });
  it('supports fleet state and rejects cross-kind synchronization', () => {
    const fleet: SyncRecord = { ...record({ status: cell('ready') }), kind: 'fleet-state' };
    expect(reconcile(fleet, fleet).writeRight).toBe(false);
    expect(() => reconcile(fleet, record({}))).toThrow('identity');
  });
  it('honors declared field owners over a newer remote edit', () => {
    const result = reconcile(record({ mission: cell('owner') }), record({ mission: cell('newer', 'github', 2) }), undefined, { owners: { mission: 'local' } });
    expect(result.record.fields.mission?.value).toBe('owner');
    expect(result.conflicts[0]?.resolution).toBe('owner');
  });
  it('protects tombstones by default and permits explicitly unprotected deletes', () => {
    const live = record({});
    const deleted = { ...live, deletion: { ...cell(true, 'github', 2), value: true } };
    expect(reconcile(live, deleted).record.deletion?.value).toBe(false);
    expect(reconcile(live, deleted).conflicts[0]?.resolution).toBe('delete-protected');
    expect(reconcile(live, deleted, undefined, { deleteProtection: false }).record.deletion?.value).toBe(true);
  });
  it('converges tied edits independent of direction without echoing sync writes', () => {
    const left = record({ a: cell(1) });
    const right = record({ a: cell(2, 'github') });
    const merged = reconcile(left, right).record;
    expect(reconcile(right, left).record).toEqual(merged);
    expect(reconcile(merged, merged)).toMatchObject({ writeLeft: false, writeRight: false, conflicts: [] });
    expect(() => reconcile(left, { ...right, updated_at: 'invalid' })).toThrow('metadata');
  });
  it('round trips files, retains conflict rows, and rejects stale concurrent writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'context-sync-'));
    try {
      const adapter = fileSyncAdapter(join(dir, 'state.json'));
      const initial = { record: record({ a: cell(1) }), conflicts: [] };
      expect(await adapter.read()).toBeUndefined();
      await adapter.write(initial, undefined);
      const merged = reconcile(initial.record, record({ a: cell(2, 'github', 2) }));
      await adapter.write(merged, initial);
      await expect(adapter.write(initial, initial)).rejects.toThrow('changed');
      const saved = await adapter.read();
      expect(saved?.conflicts).toHaveLength(1);
      expect(reconcile(saved!.record, merged.record).writeLeft).toBe(false);
      await adapter.write({ record: saved!.record, conflicts: [] }, saved);
      expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).conflicts).toHaveLength(1);
      const current = await adapter.read();
      const writes = await Promise.allSettled([1, 2].map(n => adapter.write({ record: record({ a: cell(n) }), conflicts: [] }, current)));
      expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
