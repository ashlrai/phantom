import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFleetPathHistory } from '../../src/mcp/fleet-path-history.js';

describe('fleet path history snapshot identity', () => {
  it('pins the scan before origin/master advances and matches literal paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'path-snapshot-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    try {
      git('init', '-q');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      const file = 'literal [x] space.txt';
      writeFileSync(join(dir, file), 'original');
      git('add', '--', file);
      git('commit', '-qm', 'bridge(RQ-OLD): original (#1)');
      const original = git('rev-parse', 'HEAD').trim();
      git('update-ref', 'refs/remotes/origin/master', original);
      writeFileSync(join(dir, file), 'new');
      writeFileSync(join(dir, 'literal x space.txt'), 'decoy');
      git('add', '-A');
      git('commit', '-qm', 'bridge(RQ-NEW): newer (#2)');
      const newer = git('rev-parse', 'HEAD').trim();
      let calls = 0;
      const result = await readFleetPathHistory({ path: file, limit: 10 }, {
        git: async args => {
          calls++;
          if (calls === 2) git('update-ref', 'refs/remotes/origin/master', newer);
          return git(...args);
        },
      });
      expect(calls).toBe(2);
      expect(result.resolvedRef).toBe(original);
      expect(result.jobs.map(row => [row.jobId, row.sha])).toEqual([['RQ-OLD', original]]);
      expect(git('merge-base', '--is-ancestor', result.jobs[0]!.sha, result.resolvedRef!)).toBe('');
      const decoy = await readFleetPathHistory({ path: 'literal [x] space.txt', limit: 10 }, { git: async args => git(...args) });
      expect(decoy.jobs.map(row => row.jobId)).toEqual(['RQ-NEW', 'RQ-OLD']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates missing refs and resolver errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'path-snapshot-missing-'));
    try {
      execFileSync('git', ['init', '-q', dir]);
      await expect(readFleetPathHistory({ path: 'x', limit: 1 }, {
        git: async args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      })).rejects.toThrow();
      await expect(readFleetPathHistory({ path: 'x', limit: 1 }, {
        git: async () => { throw new Error('resolver failed'); },
      })).rejects.toThrow('resolver failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps injected logs hermetic and reports unknown identity', async () => {
    const result = await readFleetPathHistory({ path: 'x', limit: 1 }, {
      log: async () => [{ sha: 'fake', date: 'fake', subject: 'bridge(RQ-FAKE): fixture' }],
      git: async () => { throw new Error('must not run'); },
    });
    expect(result.resolvedRef).toBeNull();
    expect(result.jobs[0]?.jobId).toBe('RQ-FAKE');
  });
});
