import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, selectProjects } from '../scripts/typecheck-fast.mjs';

describe('desktop typecheck recovery', () => {
  it('accepts explicit desktop and includes it in all', () => {
    expect(parseArgs(['--project', 'desktop']).project).toBe('desktop');
    expect(selectProjects([], 'desktop')).toEqual(['desktop']);
    expect(selectProjects([], 'all')).toEqual(['backend', 'web', 'desktop']);
  });

  it('selects desktop paths and shared inputs without changing web selection', () => {
    for (const path of ['desktop/src/main.ts', 'desktop/tsconfig.json', 'package.json', 'package-lock.json']) {
      expect(selectProjects([path])).toEqual(['backend', 'desktop']);
    }
    expect(selectProjects(['src/web-ui/tsconfig.json'])).toEqual(['backend', 'web', 'desktop']);
    expect(selectProjects([])).toEqual(['backend']);
    expect(selectProjects(['src/core/a.ts'])).toEqual(['backend']);
    expect(selectProjects(['src/web-ui/a.tsx'])).toEqual(['backend', 'web']);
    expect(selectProjects(['desktop-other/a.ts'])).toEqual(['backend']);
  });

  it('runs the desktop config with a distinct cache through the actual runner', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'typecheck-desktop-'));
    try {
      mkdirSync(resolve(root, 'scripts'), { recursive: true });
      mkdirSync(resolve(root, 'node_modules/typescript/bin'), { recursive: true });
      for (const file of ['typecheck-fast.mjs', 'verify-changed.mjs']) copyFileSync(resolve('scripts', file), resolve(root, 'scripts', file));
      writeFileSync(resolve(root, 'node_modules/typescript/bin/tsc'), "require('node:fs').appendFileSync('args.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');\n");
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync(process.execPath, ['scripts/typecheck-fast.mjs', '--project', 'all', '--no-seed', '--slots', '1'], {
        cwd: root, env: { ...process.env, HOME: root, PHANTOM_TSC_CACHE_DIR: resolve(root, 'shared') },
      });
      const args = readFileSync(resolve(root, 'args.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
      expect(args.map((a) => a[a.indexOf('-p') + 1])).toEqual(['tsconfig.json', 'src/web-ui/tsconfig.json', 'desktop/tsconfig.json']);
      expect(args.map((a) => a[a.indexOf('--tsBuildInfoFile') + 1])).toEqual(['backend', 'web', 'desktop'].map((name) => resolve(realpathSync(root), `node_modules/.cache/phantom-${name}.tsbuildinfo`)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
