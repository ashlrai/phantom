import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentCheckpointError, assessAgentCheckpointFreshness, parseAgentCheckpoint, readAgentCheckpoint, saveAgentCheckpoint } from '../src/core/agent-checkpoint.js';
import { cmdCheckpoint } from '../src/cli/checkpoint.js';

const checkpoint = { version: 1, goal: 'Ship safely\nwith context', done: ['Decision and rationale'], next: ['Run tests'], evidence: ['test/example.test.ts:4'], openQuestions: [] };

describe('agent checkpoint', () => {
  it('round trips all fields and ordering through a file and resume CLI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const path = join(dir, 'state.json');
      await writeFile(path, JSON.stringify(checkpoint));
      expect(await readAgentCheckpoint(path)).toEqual(checkpoint);
      expect(await cmdCheckpoint(['resume', path, '--json'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(checkpoint);
    } finally { log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });
  it('saves a private handoff with the actual worktree inventory and leaves changes intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-git-'));
    try {
      const git = (...args: string[]) => promisify(execFile)('git', ['-C', dir, ...args]);
      await git('init'); await git('config', 'user.email', 'test@example.test'); await git('config', 'user.name', 'Test');
      await writeFile(join(dir, 'tracked'), 'base'); await git('add', 'tracked'); await git('commit', '-m', 'base');
      await writeFile(join(dir, 'tracked'), 'changed'); await writeFile(join(dir, 'new file'), 'new');
      const source = join(dir, 'handoff.json'); const destination = join(dir, 'saved.json');
      await writeFile(source, JSON.stringify(checkpoint));
      const saved = await saveAgentCheckpoint(source, destination, dir);
      expect(await readAgentCheckpoint(destination)).toEqual(saved);
      expect(saved.evidence.join(' ')).toContain('tracked');
      expect(saved.evidence.join(' ')).toContain('new file');
      await expect((await import('node:fs/promises')).readFile(join(dir, 'tracked'), 'utf8')).resolves.toBe('changed');
      await expect((await import('node:fs/promises')).stat(destination).then(s => s.mode & 0o777)).resolves.toBe(0o600);
      await writeFile(source, JSON.stringify({ ...checkpoint, goal: 'password=supersecretvalue123' }));
      await expect(saveAgentCheckpoint(source, destination, dir)).rejects.toThrow(AgentCheckpointError);
      expect(await readAgentCheckpoint(destination)).toEqual(saved);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('flags a saved checkpoint stale once HEAD, the worktree or the clock moves on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-fresh-'));
    const out = await mkdtemp(join(tmpdir(), 'checkpoint-out-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const git = (...args: string[]) => promisify(execFile)('git', ['-C', dir, ...args]);
      await git('init'); await git('config', 'user.email', 'test@example.test'); await git('config', 'user.name', 'Test');
      await writeFile(join(dir, 'tracked'), 'base'); await git('add', 'tracked'); await git('commit', '-m', 'base');
      const source = join(out, 'handoff.json'); const saved = join(out, 'saved.json');
      await writeFile(source, JSON.stringify(checkpoint));
      const now = new Date('2026-01-01T00:00:00Z');
      const cp = await saveAgentCheckpoint(source, saved, dir, now);
      expect(cp.freshness?.savedAt).toBe(now.toISOString());
      expect(await assessAgentCheckpointFreshness(cp, dir, { now: new Date(now.getTime() + 1000) })).toEqual({ state: 'fresh', reasons: [] });
      expect((await assessAgentCheckpointFreshness(cp, dir, { now: new Date(now.getTime() + 48 * 3_600_000) })).state).toBe('stale');
      expect((await assessAgentCheckpointFreshness(cp, dir, { now: new Date(now.getTime() - 1000) })).state).toBe('stale');
      expect((await assessAgentCheckpointFreshness({ ...cp, freshness: undefined }, dir)).state).toBe('unverifiable');
      expect(await cmdCheckpoint(['resume', saved, dir])).toBe(3); // saved long ago
      await writeFile(join(dir, 'dirty'), 'x');
      const dirty = await assessAgentCheckpointFreshness(cp, dir, { now });
      expect(dirty.state).toBe('stale'); expect(dirty.reasons.join(' ')).toContain('Worktree changes');
      await rm(join(dir, 'dirty'));
      await git('commit', '--allow-empty', '-m', 'move');
      expect((await assessAgentCheckpointFreshness(cp, dir, { now })).reasons.join(' ')).toContain('HEAD moved');
    } finally { log.mockRestore(); err.mockRestore(); await rm(dir, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }); }
  });
  it('does not count the checkpoint file inside the worktree as drift', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-self-'));
    try {
      const git = (...args: string[]) => promisify(execFile)('git', ['-C', dir, ...args]);
      await git('init'); await git('config', 'user.email', 'test@example.test'); await git('config', 'user.name', 'Test');
      await writeFile(join(dir, 'tracked'), 'base'); await git('add', 'tracked'); await git('commit', '-m', 'base');
      await writeFile(join(dir, 'handoff.json'), JSON.stringify(checkpoint));
      const saved = join(dir, 'saved.json');
      const cp = await saveAgentCheckpoint(join(dir, 'handoff.json'), saved, dir);
      expect(await assessAgentCheckpointFreshness(cp, dir, { checkpointPath: saved })).toEqual({ state: 'fresh', reasons: [] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('rejects malformed freshness metadata', () => {
    for (const freshness of [{}, { savedAt: 'x', worktreeHead: 'a', worktreeStatusDigest: 'b' }, 'now']) {
      expect(() => parseAgentCheckpoint(JSON.stringify({ ...checkpoint, freshness }))).toThrow(AgentCheckpointError);
    }
  });
  it('rejects malformed, incomplete, unknown and secret-shaped input without echoing it', () => {
    for (const value of ['{', '{}', JSON.stringify({ ...checkpoint, extra: 1 }), JSON.stringify({ ...checkpoint, next: [''] }), JSON.stringify({ ...checkpoint, version: 2 }), JSON.stringify({ ...checkpoint, goal: 'password=supersecretvalue123' })]) {
      expect(() => parseAgentCheckpoint(value)).toThrow(AgentCheckpointError);
    }
  });
  it('reports missing files and invalid command arguments', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await cmdCheckpoint(['resume', '/no/such/checkpoint'])).toBe(2);
      expect(await cmdCheckpoint(['resume'])).toBe(2);
    } finally { error.mockRestore(); }
  });
});
