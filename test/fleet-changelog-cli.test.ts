import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetChangelog } from '../src/cli/fleet-changelog.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const CHANGELOG = `# Changelog

## [1.4.0] — Unreleased

### Added
- existing added bullet

### Fixed
- existing fix

## [1.3.0] — 2026-10-01

### Added
- dated entry must never move
`;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fleet-changelog-'));
  dirs.push(root);
  writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG);
  return root;
}

interface RunResult { code: number; out: string; err: string }

async function run(args: string[]): Promise<RunResult> {
  let out = '';
  let err = '';
  const code = await cmdFleetChangelog(args, {
    output: (text) => { out += `${text}\n`; },
    error: (text) => { err += `${text}\n`; },
  });
  return { code, out, err };
}

describe('fleet changelog add', () => {
  it('writes one fragment through the renderer', async () => {
    const root = tempRoot();
    const result = await run(['add', '--id', 'job-1', '--kind', 'fixed', 'fixed the crash', '--root', root]);
    expect(result.code).toBe(0);
    const fragment = join(root, 'changelog.d', 'job-1.fixed.md');
    expect(readFileSync(fragment, 'utf8')).toBe('### Fixed\n\n- fixed the crash\n');
  });

  it('refuses an existing fragment with exit 1 and never overwrites', async () => {
    const root = tempRoot();
    await run(['add', '--id', 'job-1', '--kind', 'fixed', 'first entry', '--root', root]);
    const result = await run(['add', '--id', 'job-1', '--kind', 'fixed', 'second entry', '--root', root]);
    expect(result.code).toBe(1);
    expect(readFileSync(join(root, 'changelog.d', 'job-1.fixed.md'), 'utf8')).toBe('### Fixed\n\n- first entry\n');
  });

  it('exits 2 on usage errors', async () => {
    const root = tempRoot();
    for (const args of [
      [] as string[],
      ['bogus'],
      ['add', '--id', 'job-2', '--root', root],
      ['add', '--id', 'job-2', '--kind', 'fixed', '--root', root],
      ['add', '--id', 'bad id!', '--kind', 'fixed', 'x', '--root', root],
      ['add', '--id', 'job-2', '--kind', 'bogus', 'x', '--root', root],
      ['add', '--id', 'job-2', '--kind', 'fixed', 'x', '--root', 'relative/path'],
      ['fold', '--bogus'],
      ['fold', '--id', 'job-2'],
    ]) {
      const result = await run(args);
      expect(result.code, JSON.stringify(args)).toBe(2);
    }
  });

  it('prints usage on --help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: ashlr fleet changelog');
  });
});

describe('fleet changelog fold', () => {
  it('previews without writing, then --apply folds and deletes the fragment', async () => {
    const root = tempRoot();
    await run(['add', '--id', 'job-9', '--kind', 'fixed', 'fresh fix', '--root', root]);
    const fragment = join(root, 'changelog.d', 'job-9.fixed.md');
    expect(existsSync(fragment)).toBe(true);

    const preview = await run(['fold', '--root', root]);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain('DRY-RUN');
    expect(preview.out).toContain('changelog.d/job-9.fixed.md');
    expect(preview.out).toContain('- fresh fix');
    // Preview writes nothing: CHANGELOG and the fragment are untouched.
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(CHANGELOG);
    expect(existsSync(fragment)).toBe(true);

    const apply = await run(['fold', '--apply', '--root', root]);
    expect(apply.code).toBe(0);
    const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(text).toContain('### Fixed\n- existing fix\n- fresh fix\n');
    expect(text.slice(text.indexOf('## [1.3.0]'))).toBe(
      CHANGELOG.slice(CHANGELOG.indexOf('## [1.3.0]')),
    );
    expect(existsSync(fragment)).toBe(false);
  });

  it('reports skipped fragments and exits 1 when no Unreleased section exists', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG.replace(' — Unreleased', ' — 2026-10-15'));
    await run(['add', '--id', 'job-3', '--kind', 'added', 'orphan entry', '--root', root]);
    const result = await run(['fold', '--apply', '--json', '--root', root]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as { ok: boolean; skipped: { path: string; reason: string }[] };
    expect(report.ok).toBe(false);
    expect(report.skipped).toEqual([
      { path: 'changelog.d/job-3.added.md', reason: 'no-unreleased-section' },
    ]);
    // The fragment stays on disk — it was not folded.
    expect(existsSync(join(root, 'changelog.d', 'job-3.added.md'))).toBe(true);
  });

  it('folds a missing heading at the end of the Unreleased section', async () => {
    const root = tempRoot();
    await run(['add', '--id', 'job-4', '--kind', 'removed', 'dropped the knob', '--root', root]);
    const apply = await run(['fold', '--apply', '--root', root]);
    expect(apply.code).toBe(0);
    const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(text).toContain('### Removed\n- dropped the knob\n\n## [1.3.0] — 2026-10-01');
  });
});
