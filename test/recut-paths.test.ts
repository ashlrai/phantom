import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const verifier = resolve('scripts/verify-recut-paths.mjs');

describe('recut path verification with diverged histories', () => {
  it.each([310, 401])('rejects unrelated paths in the %i-file case and keeps the PR edit', count => {
    const dir = mkdtempSync(join(tmpdir(), 'recut-paths-'));
    const manifest = join(tmpdir(), `recut-manifest-${process.pid}-${count}.json`);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    const verify = () => spawnSync(process.execPath, [verifier, 'HEAD', manifest], { cwd: dir, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.email', 'fixture@example.test');
      git('config', 'user.name', 'Fixture');
      writeFileSync(join(dir, 'feature.txt'), 'original\n');
      git('add', '.'); git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(dir, 'feature.txt'), 'legitimate edit\n');
      git('commit', '-qam', 'feature');
      const feature = git('rev-parse', 'HEAD');
      git('checkout', '-q', '--detach', base);
      for (let i = 0; i < count; i++) writeFileSync(join(dir, `base-${i}.txt`), 'base history\n');
      git('add', '.'); git('commit', '-qm', 'advance base');
      expect(git('diff', '--name-only', 'HEAD', feature).split('\n')).toHaveLength(count + 1);
      expect(git('diff', '--name-only', base, feature)).toBe('feature.txt');
      git('cherry-pick', '-n', feature);
      writeFileSync(manifest, JSON.stringify(['feature.txt']));
      expect(verify().status).toBe(0);
      writeFileSync(join(dir, 'unrelated.txt'), 'unexpected\n');
      expect(verify().status).toBe(1);
      expect(verify().stderr).toContain('unrelated.txt');
      rmSync(join(dir, 'unrelated.txt'));
      expect(git('diff', '--cached', '--', 'feature.txt')).toContain('+legitimate edit');
      expect(verify().status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(manifest, { force: true });
    }
  });
});
