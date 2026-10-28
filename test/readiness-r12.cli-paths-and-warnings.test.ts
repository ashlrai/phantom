/**
 * Readiness round 12: fresh-HOME CLI gaps.
 *
 * - `phm new <name> --stack <recipe>` without stack installed printed the
 *   "stack not installed" warning three times and listed it twice in --json.
 * - `phm companions --root/--bin-dir/--*-bin <missing path>` reported every
 *   companion as missing and exited 0, so a typo looked like a clean install.
 * - `phm wiki build <dir>` for a real but unenrolled directory pointed at
 *   `enroll list` (empty on a fresh HOME) instead of `enroll add <dir>`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/core/knowledge/wiki/index.js', () => ({
  wikiCandidateRepos: () => [],
  buildWiki: vi.fn(async () => { throw new Error('buildWiki must not run for an unenrolled repo'); }),
  wikiStatus: vi.fn(async () => { throw new Error('wikiStatus must not run for an unenrolled repo'); }),
  isPageId: () => true,
}));

import { cmdNew } from '../src/cli/new.js';
import { cmdCompanions } from '../src/cli/companions.js';
import { cmdWiki } from '../src/cli/wiki.js';

const roots: string[] = [];
function tempDir(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function capture(): { stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err.push(String(chunk)); return true; });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ') + '\n'); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ') + '\n'); });
  return { stdout: () => out.join(''), stderr: () => err.join('') };
}

beforeEach(() => {
  vi.stubEnv('NO_COLOR', '1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('phm new --stack without stack installed', () => {
  function stackless(): void {
    // An empty PATH: neither `which` nor `stack` can be found.
    vi.stubEnv('HOME', tempDir('phm-r12-home-'));
    vi.stubEnv('PATH', tempDir('phm-r12-path-'));
  }

  it('lists the missing-stack warning once in --json', async () => {
    stackless();
    const io = capture();
    expect(await cmdNew(['r12-json', '--stack', 'nope', '--no-git', '--json'])).toBe(0);
    const result = JSON.parse(io.stdout()) as { warnings: string[] };
    const stackWarnings = result.warnings.filter((w) => w.includes('not installed'));
    expect(stackWarnings, JSON.stringify(result.warnings)).toHaveLength(1);
    expect(stackWarnings[0]).toContain('nope');
  });

  it('prints the missing-stack warning once in human output', async () => {
    stackless();
    const io = capture();
    expect(await cmdNew(['r12-human', '--stack', 'nope', '--no-git'])).toBe(0);
    const all = io.stdout() + io.stderr();
    expect(all.match(/not installed/g) ?? []).toHaveLength(1);
  });
});

describe('phm companions refuses search paths that do not exist', () => {
  it('refuses a --root that is not a directory before probing', async () => {
    const missing = join(tempDir('phm-r12-comp-'), 'nope');
    const io = capture();
    expect(await cmdCompanions(['--root', missing, '--json'])).toBe(2);
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toContain(`--root ${missing}: no such directory`);
  });

  it('refuses a --bin-dir that is not a directory', async () => {
    const missing = join(tempDir('phm-r12-comp-'), 'nope');
    const io = capture();
    expect(await cmdCompanions(['--bin-dir', missing])).toBe(2);
    expect(io.stderr()).toContain(`--bin-dir ${missing}: no such directory`);
  });

  it('refuses an explicit --secrets-bin that does not exist', async () => {
    const missing = join(tempDir('phm-r12-comp-'), 'phantom');
    const io = capture();
    expect(await cmdCompanions(['--secrets-bin', missing])).toBe(2);
    expect(io.stderr()).toContain(`--secrets-bin ${missing}: no such file`);
  });

  it('still inventories an existing root that has no bin directory', async () => {
    const root = tempDir('phm-r12-comp-');
    const io = capture();
    expect(await cmdCompanions(['--root', root, '--json'])).toBe(0);
    expect(JSON.parse(io.stdout()).companions).toHaveLength(3);
  });
});

describe('phm wiki names the enroll step for an unenrolled directory', () => {
  it('build <dir> points at `enroll add <dir>`', async () => {
    const dir = tempDir('phm-r12-wiki-');
    const io = capture();
    expect(await cmdWiki(['build', dir, '--no-model'])).toBe(2);
    expect(io.stderr()).toContain(`${dir} is not enrolled. Enroll it with \`ashlr enroll add ${dir}\`.`);
  });

  it('status <dir with spaces> quotes the path in the enroll step', async () => {
    const dir = join(tempDir('phm-r12-wiki-'), 'my repo');
    mkdirSync(dir);
    const io = capture();
    expect(await cmdWiki(['status', dir, '--json'])).toBe(2);
    expect(io.stderr()).toContain(`\`ashlr enroll add "${dir}"\``);
  });

  it('a name that is neither enrolled nor a directory keeps the enroll list pointer', async () => {
    const io = capture();
    expect(await cmdWiki(['status', 'r12-no-such-repo'])).toBe(2);
    expect(io.stderr()).toContain('r12-no-such-repo is not an enrolled repo name or a directory');
    expect(io.stderr()).toContain('ashlr enroll list');
  });
});
