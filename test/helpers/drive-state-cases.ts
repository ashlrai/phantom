import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitStateMirror, replicateState } from '../../src/core/drive/state/mirror.js';
import { mergeState, parseState, serializeState, type QueueRecord, type StateSnapshot } from '../../src/core/drive/state/schema.js';
import { metricsFromRollup } from '../../src/core/drive/state/rollup.js';
import type { ActivityRollup } from '../../src/core/types.js';

const roots: string[] = [];
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'drive-state-'));
  roots.push(root);
  execFileSync('git', ['init', '--bare', root], { stdio: 'pipe' });
  return root;
}
const id = (n: number) => n.toString(16).padStart(64, '0');
const queue = (patch: Partial<QueueRecord> = {}): QueueRecord => ({
  kind: 'queue.v1', id: id(1), nodeId: id(10), fencingToken: 1, updatedAt: 100, status: 'pending', ...patch,
});
const state = (...records: StateSnapshot['records']): StateSnapshot => ({ schema: 'drive-state.v1', records });
function rollup(): ActivityRollup {
  // Sensitive-looking data deliberately inhabits the excluded rollup dimensions.
  return {
    window: '7d', since: '2026-10-01T00:00:00.000Z',
    totals: { tokensIn: 12, tokensOut: 6, estCostUsd: 0.25, sessions: 2, commits: 3 },
    byProject: [{ path: 'FAKE_SECRET_PROJECT', name: 'FAKE_ENV_PROJECT' }],
    byModel: [{ model: 'FAKE_SECRET_MODEL' }], byDay: [], budget: {},
  } as ActivityRollup;
}

export function registerDriveStateCases(): void {
  describe('drive state replication', () => {
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
    it('round trips queue, reservation ledger and rollup totals between two nodes', async () => {
      const directory = repository();
      const a = new GitStateMirror(directory);
      const b = new GitStateMirror(directory);
      const metrics = metricsFromRollup(rollup(), { id: id(3), nodeId: id(10), fencingToken: 1, updatedAt: 100 });
      const budget = { kind: 'budget.v1' as const, id: id(2), nodeId: id(10), fencingToken: 1, updatedAt: 100, reservedUsd: 3, spentUsd: 0, status: 'reserved' as const };
      const first = await replicateState(a, state(queue(), budget, metrics));
      expect(await replicateState(b, state())).toEqual(first);
      const second = await replicateState(b, state(queue({ fencingToken: 2, status: 'succeeded' }), { ...budget, fencingToken: 2, spentUsd: 2, status: 'settled' }));
      expect(await replicateState(a, first)).toEqual(second);
      expect(second.records).toHaveLength(3);
      const before = (await a.read()).revision;
      await replicateState(a, second);
      expect((await a.read()).revision).toBe(before);
      expect(serializeState(second)).not.toContain('FAKE_');
    });

    it('keeps disjoint writes under actual concurrent Git CAS contention', async () => {
      const directory = repository();
      const nodes = Array.from({ length: 4 }, () => new GitStateMirror(directory));
      await Promise.all(nodes.map((node, i) => replicateState(node, state(queue({ id: id(i + 1), nodeId: id(i + 10) })))));
      expect((await nodes[0].read()).snapshot.records).toHaveLength(4);
      expect(await nodes[1].compareAndSwap(null, state())).toBe(false);
    });

    it('orders by fencing token before timestamp and converges on equal versions', () => {
      const stale = state(queue({ fencingToken: 1, updatedAt: 999 }));
      const current = state(queue({ fencingToken: 2, updatedAt: 1, status: 'running' }));
      expect(mergeState(stale, current)).toEqual(current);
      const later = state(queue({ fencingToken: 2, updatedAt: 2, status: 'succeeded' }));
      expect(mergeState(current, later)).toEqual(later);
      const tie = state(queue({ fencingToken: 2, updatedAt: 2, status: 'failed', nodeId: id(11) }));
      expect(mergeState(tie, later)).toEqual(mergeState(later, tie));
      expect(mergeState(mergeState(stale, later), tie)).toEqual(mergeState(stale, mergeState(later, tie)));
      expect(mergeState(later, later)).toEqual(later);
    });

    it('rejects secret and env fields before creating any Git object', async () => {
      const directory = repository();
      const mirror = new GitStateMirror(directory);
      const fixtures = [
        { ...state(queue()), secret: 'FAKE_SECRET_VALUE' },
        state({ ...queue(), env: { API_KEY: 'FAKE_ENV_VALUE' } } as QueueRecord),
        state({ ...queue(), secretValue: 'FAKE_SECRET_VALUE' } as QueueRecord),
        state(queue({ id: 'FAKE_SECRET_IN_ID' })),
        state(queue({ status: 'FAKE_ENV_IN_STATUS' as QueueRecord['status'] })),
      ];
      for (const fixture of fixtures) {
        expect(() => serializeState(fixture)).toThrow('Invalid value-free drive state');
        await expect(replicateState(mirror, fixture)).rejects.toThrow('Invalid value-free drive state');
        await expect(mirror.compareAndSwap(null, fixture)).rejects.toThrow('Invalid value-free drive state');
      }
      expect(execFileSync('git', ['--git-dir', directory, 'cat-file', '--batch-all-objects', '--batch-check'], { encoding: 'utf8' })).toBe('');
      const safe = await replicateState(mirror, state(queue()));
      const oid = (await mirror.read()).revision!;
      const bytes = execFileSync('git', ['--git-dir', directory, 'cat-file', 'blob', oid], { encoding: 'utf8' });
      expect(bytes).toBe(serializeState(safe));
      expect(bytes).not.toContain('FAKE_');
    });

    it('rejects malformed, ambiguous and executable inputs without leaking their values', () => {
      for (const input of [
        state(queue({ fencingToken: NaN })), state(queue({ updatedAt: -1 })),
        state(queue({ fencingToken: Number.MAX_SAFE_INTEGER + 1 })),
        state(queue(), queue()), { schema: 'FAKE_SECRET_SCHEMA', records: [] },
        state({ ...queue(), toJSON: () => { throw new Error('FAKE_SECRET_HOOK'); } } as QueueRecord),
        state(Object.defineProperty(queue(), 'status', { get() { throw new Error('FAKE_ENV_GETTER'); } })),
      ]) expect(() => serializeState(input)).toThrow('Invalid value-free drive state');
      expect(() => parseState('{"FAKE_SECRET_INVALID_JSON"')).toThrow('Invalid value-free drive state');
      const metrics = metricsFromRollup(rollup(), { id: id(3), nodeId: id(10), fencingToken: 1, updatedAt: 100 });
      expect(() => serializeState(state({ ...metrics, env: 'FAKE_ENV_METRIC' } as typeof metrics))).toThrow();
      expect(() => serializeState(state({ kind: 'budget.v1', id: id(2), nodeId: id(10), fencingToken: 1, updatedAt: 100, reservedUsd: Infinity, spentUsd: 0, status: 'reserved' }))).toThrow();
    });

    it('fails closed on corrupt mirror data and refuses source checkouts', async () => {
      const directory = repository();
      const oid = execFileSync('git', ['--git-dir', directory, 'hash-object', '-w', '--stdin'], { input: '{"secret":"FAKE_SECRET_REMOTE"}', encoding: 'utf8' }).trim();
      execFileSync('git', ['--git-dir', directory, 'update-ref', 'refs/drive/state-v1', oid]);
      await expect(replicateState(new GitStateMirror(directory), state(queue()))).rejects.toThrow('Invalid value-free drive state');
      const root = mkdtempSync(join(tmpdir(), 'drive-checkout-'));
      roots.push(root);
      execFileSync('git', ['init', root], { stdio: 'pipe' });
      await expect(new GitStateMirror(join(root, '.git')).read()).rejects.toThrow('must be a bare repository');
    });

    it('does not run repository reference-transaction hooks', async () => {
      const directory = repository();
      const marker = join(directory, 'hook-ran');
      writeFileSync(join(directory, 'hooks', 'reference-transaction'),
        '#!/bin/sh\n touch "$(dirname "$0")/../hook-ran"\n exit 1\n', { mode: 0o755 });
      await replicateState(new GitStateMirror(directory), state(queue()));
      expect(existsSync(marker)).toBe(false);
    });

    it('bounds retries and propagates read failures', async () => {
      let attempts = 0;
      await expect(replicateState({
        read: async () => ({ revision: null, snapshot: state() }),
        compareAndSwap: async () => { attempts++; return false; },
      }, state(queue()))).rejects.toThrow('contention limit');
      expect(attempts).toBe(16);
      await expect(replicateState({ read: async () => { throw new Error('unavailable'); }, compareAndSwap: async () => true }, state(queue()))).rejects.toThrow('unavailable');
    });
  });
}
