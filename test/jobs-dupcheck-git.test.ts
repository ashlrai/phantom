import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitDupcheck, exportedNames } from '../src/core/queue/dupcheck-git.js';
import { cmdJobsDupcheck } from '../src/cli/jobs-dupcheck.js';

let repo = '';
const git = (...a: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'dupcheck-git-'));
  git('init', '-q', '-b', 'master');
  mkdirSync(join(repo, 'src', 'core'), { recursive: true });
  writeFileSync(join(repo, 'src', 'core', 'widget.ts'), 'export function buildWidget(): number { return 1; }\n');
  writeFileSync(join(repo, 'README.md'), 'Run `phm widget list --json` to see widgets.\n');
  git('add', '.');
  git('commit', '-q', '-m', 'add widget');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('gitDupcheck', () => {
  it('says likely done when every anchor is on master', async () => {
    const r = await gitDupcheck('Add `phm widget list --json` in src/core/widget.ts using `buildWidget`.', { repo });
    expect(r.verdict).toBe('likely done');
    expect(r.ref).toBe('master');
    expect(r.missing).toEqual([]);
  });
  it('says new when no anchor is on master', async () => {
    const r = await gitDupcheck('Add `phm gadget make` in src/core/gadget.ts using `makeGadget`.', { repo });
    expect(r.verdict).toBe('new');
    expect(r.found).toEqual([]);
  });
  it('says partly on master and lists both sides', async () => {
    const r = await gitDupcheck('Extend src/core/widget.ts with `buildGadget` and add src/core/gadget.ts.', { repo });
    expect(r.verdict).toBe('partly on master');
    expect(r.found).toEqual(['src/core/widget.ts']);
    expect(r.missing).toEqual(['src/core/gadget.ts', 'buildGadget']);
  });
  it('checks a flag only against the file that holds its command', async () => {
    const r = await gitDupcheck('Add `phm widget list --colour`.', { repo });
    expect(r.verdict).toBe('partly on master');
    expect(r.missing).toEqual(['--colour (widget list)']);
  });
  it('treats a prompt with no anchors as new', async () => {
    expect((await gitDupcheck('Make things better.', { repo })).verdict).toBe('new');
  });
  it('reads only committed files, not the working tree', async () => {
    writeFileSync(join(repo, 'src', 'core', 'draft.ts'), 'export const x = 1;\n');
    expect((await gitDupcheck('Add src/core/draft.ts.', { repo })).verdict).toBe('new');
  });
});

describe('exportedNames', () => {
  it('keeps camelCase names and drops plain words', () => {
    expect(exportedNames('`buildWidget` and `phm` and `Widget` and `value`')).toEqual(['buildWidget']);
  });
});

describe('phm jobs dupcheck', () => {
  it('prints json and exits 0 for a verdict, 2 for bad usage, 1 for a missing file', async () => {
    const file = join(repo, 'prompt.txt');
    writeFileSync(file, 'Add `phm gadget make`.');
    const lines: string[] = [];
    const log = console.log, err = console.error;
    console.log = (m: string) => { lines.push(m); }; console.error = () => {};
    try {
      expect(await cmdJobsDupcheck([file, '--repo', repo, '--json'])).toBe(0);
      expect(JSON.parse(lines[0]!).verdict).toBe('new');
      expect(await cmdJobsDupcheck([])).toBe(2);
      expect(await cmdJobsDupcheck([join(repo, 'nope.txt'), '--json'])).toBe(1);
    } finally { console.log = log; console.error = err; }
  });
});
