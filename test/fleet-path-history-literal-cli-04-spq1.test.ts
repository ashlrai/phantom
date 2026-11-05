import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { cmdFleetPathHistory } from '../src/cli/fleet-path-history.js';

/**
 * CLI path mode must use --literal-pathspecs so that filenames containing
 * brackets (or other glob magic) are matched literally, exactly like the MCP
 * path-history reader.  This test creates a temporary repository with a real
 * literal-bracket file alongside a matching glob filename and distinct bridge
 * commits, then proves that querying the literal returns only its own job.
 *
 * Also exercises: option-like and colon-magic filenames, a valid alternate
 * ref, out-of-range limit/ref rejection, and invalid-argument routing.
 */
it('path mode uses literal pathspec semantics and -- before the path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'path-history-literal-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  try {
    // Initialise repo with a trusted user.
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');

    // Create a literal-file (brackets in name) and a file matching the same
    // glob pattern — they must differ so the query can distinguish them.
    writeFileSync(join(dir, 'literal [x].txt'), 'x content');
    writeFileSync(join(dir, 'literal [a].txt'), 'a content');

    // First commit: only the literal [x] file (job RQ-LIT-X01).
    git('add', '.');
    git('commit', '-m', 'bridge(RQ-LIT-X01): add literal-x (#42)');

    // Second commit: only the glob-matching [a] file (job RQ-LIT-A02).
    writeFileSync(join(dir, 'literal [a].txt'), 'a updated');
    git('commit', '-am', 'bridge(RQ-LIT-A02): add literal-a (#43)');

    // Third commit: touching the literal file again (job RQ-BR-B03) so the
    // literal file has two bridge commits and the glob file has one.
    writeFileSync(join(dir, 'literal [x].txt'), 'x updated');
    git('commit', '-am', 'bridge(RQ-BR-B03): update literal-x (#44)');

    // Fourth commit: a plain (non-bridge) commit touching the glob file —
    // should not appear in job results.
    writeFileSync(join(dir, 'literal [a].txt'), 'a plain');
    git('commit', '-am', 'plain update to literal-a');

    process.chdir(dir);

    // Query the literal filename with brackets — should return only the two
    // bridge jobs that touched 'literal [x].txt', NOT the glob-matching job.
    expect(await cmdFleetPathHistory(['literal [x].txt', '--ref', 'HEAD'])).toBe(0);
    const output = log.mock.calls.map(call => call[0]).filter(c => typeof c === 'string').join('\n');
    expect(output).toContain('#42 RQ-LIT-X01');
    expect(output).toContain('#44 RQ-BR-B03');
    // The glob-matching job must NOT appear — this is the literal-pathspec test.
    expect(output).not.toContain('RQ-LIT-A02');

    // Test option-like filename (starts with dashes) — the CLI parser treats
    // args starting with '-' as flags/option-flags, so this returns usage/2.
    expect(await cmdFleetPathHistory(['--literal [d].txt', '--ref', 'HEAD'])).toBe(2);

    // Test colon-magic filename: a file starting with ':' is a pathspec-magic
    // prefix in git but here it should be treated as a literal path name.
    // The CLI parser accepts anything that does not start with '-'.
    writeFileSync(join(dir, ':magic:name.txt'), 'magic content');
    git('add', '.');
    git('commit', '-m', 'bridge(RQ-COL-C04): add colon-magic (#45)');

    expect(await cmdFleetPathHistory([':magic:name.txt', '--ref', 'HEAD'])).toBe(0);
  } finally {
    process.chdir(cwd);
    log.mockRestore();
    error.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('path mode rejects out-of-range limit and invalid refs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'path-history-limit-'));
  const cwd = process.cwd();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  try {
    git('init');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-m', 'bridge(RQ-LIM-M01): init (#50)');

    process.chdir(dir);

    // Limit exceeding JOB_LIMIT_MAX (100) should return usage/2.
    expect(await cmdFleetPathHistory(['a.txt', '--ref', 'HEAD', '--limit', '101'])).toBe(2);

    // An invalid ref (that does not resolve) should return 1 (error).
    expect(await cmdFleetPathHistory(['a.txt', '--ref', 'refs/no/such/ref'])).toBe(1);

    // Valid alternate refs (tags, other branch names) should work.
    git('tag', 'v1.0');
    expect(await cmdFleetPathHistory(['a.txt', '--ref', 'v1.0'])).toBe(0);
  } finally {
    process.chdir(cwd);
    error.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('invalid arguments return usage/2 for path mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'path-history-args-'));
  const cwd = process.cwd();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  try {
    git('init');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-m', 'bridge(RQ-ARG-A01): init (#60)');
    process.chdir(dir);

    // No path or job.
    expect(await cmdFleetPathHistory([])).toBe(2);

    // Both path and job specified.
    expect(await cmdFleetPathHistory(['a.txt', '--job', 'RQ-BAD-B02'])).toBe(2);

    // Negative or non-integer limit.
    expect(await cmdFleetPathHistory(['a.txt', '--limit', '-1'])).toBe(2);
    expect(await cmdFleetPathHistory(['a.txt', '--limit', 'abc'])).toBe(2);

    // Missing value after --ref.
    expect(await cmdFleetPathHistory(['a.txt', '--ref'])).toBe(2);
  } finally {
    process.chdir(cwd);
    error.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
