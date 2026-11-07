import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentCheckpointError, parseAgentCheckpoint, readAgentCheckpoint } from '../src/core/agent-checkpoint.js';
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
