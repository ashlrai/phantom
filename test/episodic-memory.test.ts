import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodicMemoryStore, retrieveEpisodicMemory, type EpisodicWrite } from '../src/core/memory/episodic.js';

describe('verifiable episodic memory', () => {
  let root: string;
  let repo: string;
  let path: string;
  let store: EpisodicMemoryStore;
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const commit = () => { git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'); };
  const input = (): EpisodicWrite => ({ repo: 'owner/repo', repo_dir: repo, task_class: 'bugfix', files: ['a.ts'],
    claim: 'Use the tested approach', approach: 'Reproduce then fix', outcome: 'success',
    evidence: [{ kind: 'test', command: 'npm test', result: '1 passed', exit_code: 0 }] });
  const query = () => ({ repo: 'owner/repo', repo_dir: repo, task_class: 'bugfix', files: ['a.ts'] });
  beforeEach(async () => {
    vi.stubEnv('PHANTOM_EPISODIC_MEMORY', '1');
    root = await mkdtemp(join(tmpdir(), 'episodic-'));
    repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    await writeFile(join(repo, 'a.ts'), 'initial\n');
    await writeFile(join(repo, 'b.ts'), 'unchanged\n');
    commit();
    path = join(root, 'data', 'episodic.jsonl');
    store = new EpisodicMemoryStore(path);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it('accepts unchanged blobs across revisions and rejects changed blobs with a reason', async () => {
    const entry = await store.write(input());
    expect(entry?.repo_revision).toBe(git('rev-parse', 'HEAD'));
    expect(entry?.files[0]?.blob_hash).toBe(git('rev-parse', 'HEAD:a.ts'));
    await writeFile(join(repo, 'b.ts'), 'unrelated change\n'); commit();
    expect((await store.retrieve(query())).entries).toEqual([entry]);
    await writeFile(join(repo, 'a.ts'), 'changed\n'); commit();
    expect(await store.retrieve(query())).toEqual({ entries: [], rejected: [{ id: entry?.id, reason: 'stale',
      files: [{ path: 'a.ts', reason: 'blob-changed' }] }] });
  });
  it('checks all referenced files, including deletions outside the query overlap', async () => {
    await store.write({ ...input(), files: ['a.ts', 'b.ts'] });
    git('rm', 'b.ts'); commit();
    expect((await store.retrieve(query())).rejected[0]?.files).toEqual([{ path: 'b.ts', reason: 'file-deleted' }]);
  });
  it('preserves failed outcomes and evidence across store restart through the eval hook', async () => {
    const failed = await store.write({ ...input(), outcome: 'failed', evidence: [{ kind: 'typecheck',
      command: 'npm run typecheck', result: 'type error', exit_code: 1 }] });
    const result = await retrieveEpisodicMemory(query(), new EpisodicMemoryStore(path));
    expect(result.entries).toEqual([failed]);
    expect(result.entries[0]?.outcome).toBe('failed');
    expect(result.entries[0]?.evidence[0]?.exit_code).toBe(1);
  });
  it('filters repo, task class and path overlap', async () => {
    await store.write(input());
    for (const change of [{ repo: 'other' }, { task_class: 'feature' }, { files: ['b.ts'] }, { files: [] }]) {
      expect(await store.retrieve({ ...query(), ...change })).toEqual({ entries: [], rejected: [] });
    }
  });
  it('defaults off without filesystem or git effects, including for the eval hook', async () => {
    vi.stubEnv('PHANTOM_EPISODIC_MEMORY', undefined);
    expect(await store.write({ ...input(), repo_dir: '/missing' })).toBeNull();
    expect(await retrieveEpisodicMemory({ ...query(), repo_dir: '/missing' }, store)).toEqual({ entries: [], rejected: [] });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    vi.stubEnv('PHANTOM_EPISODIC_MEMORY', 'true');
    expect(await store.write(input())).toBeNull();
  });
  it('scrubs claim, approach, metadata and evidence before writing and returns scrubbed evidence', async () => {
    const secret = 'password=synthetic-secret-value';
    const entry = await store.write({ ...input(), claim: secret, approach: secret,
      evidence: [{ kind: 'command', command: secret, result: secret, pr: secret }] });
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain('synthetic-secret-value');
    expect(persisted).toContain('[REDACTED]');
    expect((await store.retrieve(query())).entries).toEqual([entry]);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it('refuses absent or escaping file references and empty evidence', async () => {
    for (const files of [['missing.ts'], ['../outside'], ['/absolute'], []]) {
      await expect(store.write({ ...input(), files })).rejects.toThrow();
    }
    await expect(store.write({ ...input(), evidence: [] })).rejects.toThrow();
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
