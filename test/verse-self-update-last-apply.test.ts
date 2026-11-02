import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSelfUpdateLastApply } from '../src/core/verse/self-update-last.js';
import { readSelfUpdateStatus } from '../src/core/verse/self-update-status.js';

const record = {
  v: 1, outcome: 'updated', reason: null, startedAt: '2026-10-31T10:00:00Z', finishedAt: '2026-10-31T10:01:00Z',
  fromCommit: 'a'.repeat(40), toCommit: 'b'.repeat(40), steps: [], restart: { required: true, mode: 'manual' },
};
const lastApply = { outcome: 'updated' as const, reason: null, startedAt: record.startedAt, finishedAt: record.finishedAt,
  fromCommit: record.fromCommit, toCommit: record.toCommit, restartRequired: true, restartMode: 'manual' as const };

describe('last self-update result', () => {
  it('reads and projects a valid durable result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'last-apply-'));
    try {
      const path = join(dir, 'result.json');
      writeFileSync(path, JSON.stringify(record));
      expect(readSelfUpdateLastApply(path)).toEqual(lastApply);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('returns null for missing files, malformed JSON and wrong shapes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'last-apply-'));
    try {
      const path = join(dir, 'result.json');
      expect(readSelfUpdateLastApply(path)).toBeNull();
      for (const text of ['{', 'null', '{}', ...[
        { v: 2 }, { outcome: 'unknown' }, { reason: 42 }, { finishedAt: 'bad' },
        { fromCommit: 42 }, { restart: { required: 'yes', mode: 'manual' } }, { steps: [null] },
      ].map((over) => JSON.stringify({ ...record, ...over }))]) {
        writeFileSync(path, text);
        expect(readSelfUpdateLastApply(path)).toBeNull();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('includes injected history even without a repository', async () => {
    expect(await readSelfUpdateStatus({ repoRoot: () => null, readLastApply: () => lastApply }))
      .toMatchObject({ lastApply, sourceState: 'unavailable' });
  });
  it('does not degrade healthy status when history reading throws', async () => {
    const status = await readSelfUpdateStatus({
      repoRoot: () => '/fixture', readPackageVersion: () => '1.0.0', statFetchHead: () => null,
      readLastApply: () => { throw new Error('unreadable'); },
      runGit: async (args) => ({ code: 0, stdout: args[0] === 'status' ? '' : args[0] === 'rev-list' ? '0 0'
        : args[0] === 'show' ? record.finishedAt : args.includes('--abbrev-ref') ? 'master' : record.fromCommit }),
    });
    expect(status).toMatchObject({ lastApply: null, sourceState: 'healthy' });
  });
});
