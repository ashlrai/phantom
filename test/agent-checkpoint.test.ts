import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentCheckpointError, parseAgentCheckpoint, readAgentCheckpoint, saveAgentCheckpoint } from '../src/core/agent-checkpoint.js';
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
