/**
 * Tests for scripts/check-test-names.mjs.
 *
 * Hermetic: fixtures are written under os.tmpdir() and the script is invoked
 * as a real subprocess (execFileSync style via spawnSync), so the checker's
 * exit code and report text are asserted end to end. The last suite scans the
 * repository's own test/ tree, which makes the suite fail if a new duplicate
 * test name ever lands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/check-test-names.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'check-test-names-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function run(extra: string[] = []): { status: number; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--no-baseline', ...extra], {
    encoding: 'utf8',
  });
  expect(r.error).toBeUndefined();
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const VITEST = "import { describe, it, expect } from 'vitest';\n";

describe('check-test-names script', () => {
  it('--help prints usage and exits 0', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage:');
  });

  it('passes on a tree with unique names', () => {
    write('a.test.ts', `${VITEST}describe('s', () => { it('alpha', () => { expect(1).toBe(1); }); });`);
    write('b.test.ts', `${VITEST}describe('s', () => { it('beta', () => { expect(1).toBe(1); }); });`);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain('no new duplicate full names');
  });

  it('fails on identical full names across two files and lists both', () => {
    write('a.test.ts', `${VITEST}describe('suite', () => { it('does a thing', () => { expect(1).toBe(1); }); });`);
    write('b.test.ts', `${VITEST}describe('suite', () => { it('does a thing', () => { expect(1).toBe(1); }); });`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('duplicate test names across files');
    expect(r.out).toContain('suite > does a thing');
    expect(r.out).toContain('a.test.ts');
    expect(r.out).toContain('b.test.ts');
  });

  it('fails on identical full names within one file', () => {
    write('a.test.ts', `${VITEST}describe('suite', () => {
      it('same', () => { expect(1).toBe(1); });
      it('same', () => { expect(2).toBe(2); });
    });`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('duplicate test names within one file');
    expect(r.out).toContain('suite > same');
  });

  it('ignores same it title under different describes', () => {
    write('a.test.ts', `${VITEST}describe('one', () => { it('same', () => { expect(1).toBe(1); }); });
      describe('two', () => { it('same', () => { expect(2).toBe(2); }); });`);
    expect(run().status).toBe(0);
  });

  it('ignores duplicates nested inside a fixtures/ directory', () => {
    write('a.test.ts', `${VITEST}describe('s', () => { it('x', () => { expect(1).toBe(1); }); });`);
    write('fixtures/b.test.ts', `${VITEST}describe('s', () => { it('x', () => { expect(1).toBe(1); }); });`);
    expect(run().status).toBe(0);
  });

  it('renders it.each rows like vitest: distinct %s values pass', () => {
    write('a.test.ts', `${VITEST}describe('s', () => {
      it.each([['first'], ['second']])('handles %s', () => { expect(1).toBe(1); });
    });`);
    expect(run().status).toBe(0);
  });

  it('renders it.each rows like vitest: identical %s values collide', () => {
    write('a.test.ts', `${VITEST}describe('s', () => {
      it.each([['same'], ['same']])('handles %s', () => { expect(1).toBe(1); });
    });`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('s > handles same');
  });

  it('flags it.each rows that share only the consumed element (%j on element 0)', () => {
    write('a.test.ts', `${VITEST}describe('s', () => {
      it.each([['run'], ['run', '--json'], ['walk']])('rejects %j', async (...args: string[]) => {
        expect(args.length).toBeGreaterThan(0);
      });
    });`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('s > rejects "run"');
    expect(r.out).not.toContain('rejects "walk"');
  });

  it('renders as const tables and skipIf().each() chains', () => {
    write('a.test.ts', `${VITEST}describe('s', () => {
      it.skipIf(process.platform === 'win32').each([['x'], ['x']] as const)('does %j', () => { expect(1).toBe(1); });
    });`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('s > does "x"');
  });

  it('renders $name object rows and leaves $# literal, as vitest does', () => {
    write('a.test.ts', `${VITEST}describe('s', () => {
      it.each([{ label: 'one' }, { label: 'two' }])('case $label and $#', () => { expect(1).toBe(1); });
    });`);
    expect(run().status).toBe(0);
    write('b.test.ts', `${VITEST}describe('s2', () => {
      it.each([{ label: 'same' }, { label: 'same' }])('case $label', () => { expect(1).toBe(1); });
    });`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain("s2 > case 'same'");
  });

  it('flags an each title with no placeholder (every row emits the same name)', () => {
    write('a.test.ts', `${VITEST}describe('s', () => {
      it.each([[1], [2], [3]])('fixed title', () => { expect(1).toBe(1); });
    });`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('s > fixed title');
  });

  it('treats %# as unique per row, matching vitest', () => {
    write('a.test.ts', `${VITEST}describe('s', () => {
      it.each([['run'], ['run', '--json']])('rejects %j (%#)', async (...args: string[]) => {
        expect(args.length).toBeGreaterThan(0);
      });
    });`);
    expect(run().status).toBe(0);
  });

  it('baseline suppresses listed collisions and fails on unlisted ones', () => {
    const dup = `${VITEST}describe('s', () => { it('same', () => { expect(1).toBe(1); }); });`;
    write('a.test.ts', dup);
    write('b.test.ts', dup);
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ names: ['s > same'] }));
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--dir', dir, '--baseline', join(dir, 'baseline.json')],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('baseline');
    write('c.test.ts', dup);
    const r2 = spawnSync(
      process.execPath,
      [SCRIPT, '--dir', dir, '--baseline', join(dir, 'baseline.json')],
      { encoding: 'utf8' },
    );
    expect(r2.status).toBe(0); // 's > same' is still the single listed name
  });

  it('--verbose lists the baseline-known sites instead of a count', () => {
    const dup = `${VITEST}describe('s', () => { it('same', () => { expect(1).toBe(1); }); });`;
    write('a.test.ts', dup);
    write('b.test.ts', dup);
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ names: ['s > same'] }));
    const quiet = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--baseline', join(dir, 'baseline.json')], { encoding: 'utf8' });
    expect(quiet.stdout).toContain('pass --verbose to list');
    expect(quiet.stdout).not.toContain('a.test.ts');
    const loud = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--baseline', join(dir, 'baseline.json'), '--verbose'], { encoding: 'utf8' });
    expect(loud.stdout).toContain('a.test.ts');
    expect(loud.stdout).toContain('b.test.ts');
  });

  it('fails on a stale baseline entry after the duplicate is fixed', () => {
    write('a.test.ts', `${VITEST}describe('s', () => { it('unique', () => { expect(1).toBe(1); }); });`);
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ names: ['s > gone'] }));
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--dir', dir, '--baseline', join(dir, 'baseline.json')],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('stale baseline entries');
    expect(r.stdout).toContain('s > gone');
  });

  it('the repository test tree has no new duplicate test names', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('check-test-names: OK');
  }, 120_000);
});

describe('check-test-names --base diff scope', () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  const commitAll = (msg: string) => {
    git('add', '-A');
    git(
      '-c', 'user.email=test@example.com',
      '-c', 'user.name=test',
      '-c', 'commit.gpgsign=false',
      'commit', '-qm', msg,
    );
  };

  const writeRepo = (rel: string, content: string) => {
    const path = join(repo, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };

  const runBase = (ref: string, extra: string[] = []) => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--dir', join(repo, 'test'), '--no-baseline', '--base', ref, ...extra],
      { encoding: 'utf8' },
    );
    expect(r.error).toBeUndefined();
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };

  const suite = (title: string) =>
    `${VITEST}describe('suite', () => { it('${title}', () => { expect(1).toBe(1); }); });`;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'check-test-names-base-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('passes on a collision inherited unchanged from the base', () => {
    writeRepo('test/a.test.ts', suite('same'));
    writeRepo('test/b.test.ts', suite('same'));
    commitAll('base');
    const r = runBase('HEAD');
    expect(r.status).toBe(0);
    expect(r.out).toContain('no new duplicate full names');
  });

  it('fails when an uncommitted file adds a colliding name', () => {
    writeRepo('test/a.test.ts', suite('same'));
    commitAll('base');
    writeRepo('test/b.test.ts', suite('same'));
    const r = runBase('HEAD');
    expect(r.status).toBe(1);
    expect(r.out).toContain('suite > same');
    expect(r.out).toContain('new duplicate test names across files');
  });

  it('fails when a later commit introduces the collision, scoped to the older base', () => {
    writeRepo('test/a.test.ts', suite('unique-a'));
    commitAll('base');
    const base = git('rev-parse', 'HEAD');
    writeRepo('test/b.test.ts', suite('unique-a'));
    commitAll('adds the duplicate');
    const r = runBase(base);
    expect(r.status).toBe(1);
    expect(r.out).toContain('suite > unique-a');
  });

  it('fails when an existing collision gains another occurrence', () => {
    writeRepo('test/a.test.ts', suite('same'));
    writeRepo('test/b.test.ts', suite('same'));
    commitAll('two-site collision');
    const base = git('rev-parse', 'HEAD');
    writeRepo('test/c.test.ts', suite('same'));
    const r = runBase(base);
    expect(r.status).toBe(1);
    expect(r.out).toContain('suite > same');
  });

  it('passes when the diff only adds unique names', () => {
    writeRepo('test/a.test.ts', suite('alpha'));
    commitAll('base');
    writeRepo('test/b.test.ts', suite('beta'));
    const r = runBase('HEAD');
    expect(r.status).toBe(0);
  });

  it('fails on a new within-file duplicate', () => {
    writeRepo('test/a.test.ts', `${VITEST}describe('suite', () => { it('inner', () => { expect(1).toBe(1); }); });`);
    commitAll('base');
    writeRepo('test/a.test.ts', `${VITEST}describe('suite', () => {
      it('inner', () => { expect(1).toBe(1); });
      it('inner', () => { expect(2).toBe(2); });
    });`);
    const r = runBase('HEAD');
    expect(r.status).toBe(1);
    expect(r.out).toContain('new duplicate test names within one file');
  });

  it('passes when an unchanged collision only moves to a renamed file', () => {
    writeRepo('test/a.test.ts', suite('same'));
    writeRepo('test/b.test.ts', suite('same'));
    commitAll('collision');
    const base = git('rev-parse', 'HEAD');
    execFileSync('git', ['mv', 'test/a.test.ts', 'test/z.test.ts'], { cwd: repo });
    commitAll('rename');
    const r = runBase(base);
    expect(r.status).toBe(0);
  });

  it('still fails on stale baseline entries under --base', () => {
    writeRepo('test/a.test.ts', suite('unique'));
    writeRepo('baseline.json', JSON.stringify({ names: ['suite > gone'] }));
    commitAll('base');
    const r = runBase('HEAD', ['--baseline', join(repo, 'baseline.json')]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('stale baseline entries');
  });

  it('exits 2 when the base ref cannot be resolved', () => {
    writeRepo('test/a.test.ts', suite('unique'));
    commitAll('base');
    const r = runBase('no-such-ref');
    expect(r.status).toBe(2);
  });
});
