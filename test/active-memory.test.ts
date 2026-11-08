import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeMemoryContext, readActiveMemory, saveActiveMemory } from '../src/core/memory/active.js';
import { resumeAgentCheckpointWithMemory } from '../src/core/agent-checkpoint.js';
import type { MemoryFactEvent, MemoryPackQuery, MemorySnapshot } from '../src/core/memory/types.js';

const at = '2026-01-01T00:00:00.000Z';
const query: MemoryPackQuery = { schemaVersion: 1, projectId: 'repo', ownerId: 'owner', audienceId: 'agent', time: { mode: 'current', at }, knownAt: null, query: 'build command', maxBytes: 8192, maxFacts: 8, authority: false };
const digest = (s: string) => `sha256_${createHash('sha256').update(s).digest('hex')}`;
function fact(id: string, file: string, content: string): MemoryFactEvent {
  return { schemaVersion: 1, eventId: id, factId: id, revision: 1, kind: 'fact', projectId: 'repo', ownerId: 'owner', audienceIds: ['agent'], subjectKey: id, slotKey: 'command', text: 'The build command uses npm', sourceRefs: [{ id, digest: digest(content), locator: `file:${file}`, quote: content, observedAt: at }], observedAt: at, validFrom: at, validUntil: null, recordedAt: at, reviewState: 'approved', reviewedAt: at, reviewerDecisionId: 'review', supersedes: [], derivedFrom: [], tombstones: [], authority: false };
}
function snapshot(events: MemoryFactEvent[]): MemorySnapshot {
  return { schemaVersion: 1, snapshotId: 'snapshot', revision: 1, recordedThrough: at, sourceState: 'available', complete: true, events, authority: false };
}

describe('active memory', () => {
  it('persists screened evidence privately and resumes with live scoped context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'active-memory-'));
    try {
      const file = join(dir, 'source'); const store = join(dir, 'memory'); const checkpoint = join(dir, 'checkpoint');
      await writeFile(file, 'npm run build');
      await writeFile(checkpoint, JSON.stringify({ version: 1, goal: 'Build', done: [], next: [], evidence: [], openQuestions: [] }));
      await saveActiveMemory(store, snapshot([fact('one', 'source', 'npm run build')]));
      await expect(saveActiveMemory(store, snapshot([]))).rejects.toThrow();
      const result = await resumeAgentCheckpointWithMemory(checkpoint, store, query, dir);
      expect(result.checkpoint.goal).toBe('Build');
      expect(result.memory.items.map(item => item.eventId)).toEqual(['one']);
      expect((await activeMemoryContext(await readActiveMemory(store), { ...query, audienceId: 'other' }, dir)).items).toEqual([]);
      await writeFile(file, 'npm run build:changed');
      const stale = await activeMemoryContext(await readActiveMemory(store), query, dir);
      expect(stale.items).toEqual([]);
      expect(stale.receipt.exclusions).toContainEqual({ eventId: 'one', reason: 'source-changed' });
      expect(await readFile(store, 'utf8')).not.toContain('build:changed');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('prefers newer observations when relevance and evidence quality tie', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'active-memory-'));
    try {
      await writeFile(join(dir, 'old'), 'npm run build');
      await writeFile(join(dir, 'new'), 'npm run build:prod');
      const old = fact('a-old', 'old', 'npm run build');
      old.observedAt = old.validFrom = old.recordedAt = old.reviewedAt = '2025-01-01T00:00:00.000Z';
      old.sourceRefs[0]!.observedAt = old.observedAt;
      const newer = fact('z-new', 'new', 'npm run build:prod');
      newer.text = 'The build command uses npm production';
      const result = await activeMemoryContext(snapshot([old, newer]), { ...query, maxFacts: 1 }, dir);
      expect(result.items[0]?.eventId).toBe('z-new');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('refuses secret-shaped records and escaping or missing sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'active-memory-'));
    try {
      const unsafe = fact('secret', 'source', 'npm run build'); unsafe.text = 'password=supersecretvalue123';
      await expect(saveActiveMemory(join(dir, 'unsafe'), snapshot([unsafe]))).rejects.toThrow();
      await symlink(tmpdir(), join(dir, 'outside'));
      const result = await activeMemoryContext(snapshot([fact('escape', 'outside/anything', 'x'), fact('missing', 'missing', 'x')]), query, dir);
      expect(result.items).toEqual([]);
      expect(result.receipt.exclusions.filter(x => x.reason === 'source-changed')).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
