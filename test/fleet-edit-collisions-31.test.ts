import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetEditCollisions } from '../src/cli/fleet-edit-collisions.js';

interface RunResult { code: number; out: string; err: string }

/**
 * `stdinText === null` simulates a terminal (nothing piped); a string is one
 * piped chunk. A real `git diff --name-only` emit is exercised via
 * cmdFleetEditCollisions' stdin dep.
 */
async function run(args: string[], stdinText: string | null = null): Promise<RunResult> {
  let out = '';
  let err = '';
  const code = await cmdFleetEditCollisions(args, {
    stdin: Readable.from(stdinText === null ? [] : [stdinText]),
    stdinIsTty: stdinText === null,
    stdout: text => { out += text; },
    stderr: text => { err += text; },
  });
  return { code, out, err };
}

interface EditCollisionsReport {
  schema: string;
  ok: boolean;
  checked: number;
  refusals: Array<{ path: string; rule: string; why: string; redirect: string | null; useInstead: string | null }>;
}
function report(result: RunResult): EditCollisionsReport {
  return JSON.parse(result.out) as EditCollisionsReport;
}

describe('fleet edit-collisions', () => {
  it('refuses a list with CHANGELOG.md and a lockfile, naming both', async () => {
    const result = await run(['--json', '--paths', 'CHANGELOG.md', 'package-lock.json']);
    expect(result.code).toBe(1);
    expect(report(result)).toMatchObject({
      schema: 'fleet.edit-collisions.v1', ok: false, checked: 2,
      refusals: [
        { path: 'CHANGELOG.md', rule: 'changelog-singleton', redirect: 'changelog-fragment', useInstead: 'changelog.d/<id>.<kind>.md' },
        { path: 'package-lock.json', rule: 'lockfile', redirect: null, useInstead: null },
      ],
    });
    expect(result.out).toContain('CHANGELOG.md');
    expect(result.out).toContain('package-lock.json');
  });

  it('admits a list of ordinary source paths', async () => {
    const result = await run(['--json', '--paths', 'src/cli/a.ts', 'src/core/b.ts', 'docs/guide.md']);
    expect(result.code).toBe(0);
    expect(report(result)).toMatchObject({ ok: true, checked: 3, refusals: [] });
    expect(result.err).toBe('');
  });

  it('reads newline-delimited paths from piped stdin like git diff --name-only', async () => {
    const result = await run(['--json'], 'src/a.ts\nCHANGELOG.md\nyarn.lock\n');
    expect(result.code).toBe(1);
    const parsed = report(result);
    expect(parsed.checked).toBe(3);
    expect(parsed.refusals.map(refusal => `${refusal.path}:${refusal.rule}`)).toEqual([
      'CHANGELOG.md:changelog-singleton', 'yarn.lock:lockfile',
    ]);
  });

  it('reads NUL-delimited stdin (git diff --name-only -z)', async () => {
    const result = await run(['--json'], 'src/a.ts\0CLAUDE.md\0');
    expect(result.code).toBe(1);
    const parsed = report(result);
    expect(parsed.checked).toBe(2);
    expect(parsed.refusals).toMatchObject([{ path: 'CLAUDE.md', rule: 'agent-guide' }]);
  });

  it('unions argv paths with stdin paths', async () => {
    const result = await run(['--json', 'README.md'], 'src/x.ts\nCargo.lock\n');
    expect(result.code).toBe(1);
    const parsed = report(result);
    expect(parsed.checked).toBe(3);
    expect(parsed.refusals.map(refusal => refusal.rule)).toEqual(['readme-singleton', 'lockfile']);
  });

  it('treats an empty piped list as a clean empty diff', async () => {
    const result = await run(['--json'], '');
    expect(result.code).toBe(0);
    expect(report(result)).toMatchObject({ ok: true, checked: 0, refusals: [] });
  });

  it('exits 2 on bad input', async () => {
    const unknown = await run(['--bogus']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown option: --bogus');
    expect((await run([])).code).toBe(2);
    const barePaths = await run(['--paths']);
    expect(barePaths.code).toBe(2);
    expect(barePaths.err).toContain('no paths to check');
  });

  it('ends option parsing at -- so dash-leading names are checked as paths', async () => {
    const result = await run(['--json', '--', '--json', 'weird--name.ts']);
    expect(result.code).toBe(0);
    expect(report(result).checked).toBe(2);
  });

  it('refuses paths that cannot be normalized rather than passing them', async () => {
    const result = await run(['--json', '--paths', '../secrets.env', '/abs/README.md', '.git/config']);
    expect(result.code).toBe(1);
    expect(report(result).refusals.map(refusal => refusal.rule)).toEqual([
      'unsafe-path', 'unsafe-path', 'unsafe-path',
    ]);
  });

  it('deduplicates refusals only for paths that normalize identically', async () => {
    const same = await run(['--json', 'CHANGELOG.md', './CHANGELOG.md', '././CHANGELOG.md']);
    expect(same.code).toBe(1);
    expect(report(same).refusals).toHaveLength(1);
    // Case variants are distinct normalized paths: each names what the edit named.
    const folded = await run(['--json', 'CHANGELOG.md', 'changelog.md']);
    expect(report(folded).refusals.map(refusal => refusal.path)).toEqual(['CHANGELOG.md', 'changelog.md']);
  });

  it('prints usage on --help and exits 0', async () => {
    for (const flag of ['--help', '-h']) {
      const result = await run([flag]);
      expect(result.code).toBe(0);
      expect(result.out).toContain('Usage: ashlr fleet edit-collisions');
      expect(result.err).toBe('');
    }
  });

  it('prints one line per refusal with the fragment path in human output', async () => {
    const result = await run(['CHANGELOG.md', 'src/ok.ts'], 'pnpm-lock.yaml\n');
    expect(result.code).toBe(1);
    expect(result.out).toContain('refused 2 of 3 paths');
    expect(result.out).toMatch(/refused CHANGELOG\.md \[changelog-singleton\].*use changelog\.d\/<id>\.<kind>\.md/);
    expect(result.out).toContain('refused pnpm-lock.yaml [lockfile]');
  });

  it('exits 2 when stdin exceeds the byte cap or fails mid-read', async () => {
    let err = '';
    const oversize = await cmdFleetEditCollisions([], {
      stdin: Readable.from([Buffer.alloc(1024 * 1024 + 1)]),
      stdout: () => {}, stderr: text => { err += text; },
    });
    expect(oversize).toBe(2);
    expect(err).toContain('stdin exceeds');
    err = '';
    const failing = new Readable({ read() { this.destroy(new Error('boom')); } });
    const failed = await cmdFleetEditCollisions([], {
      stdin: failing, stdout: () => {}, stderr: text => { err += text; },
    });
    expect(failed).toBe(2);
    expect(err).toContain('stdin read error');
  });

  it('is reachable through cmdFleet dispatch', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const had = Object.hasOwn(process.stdin, 'isTTY');
    const original = (process.stdin as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, writable: true, value: true });
    try {
      expect(await cmdFleet(['edit-collisions', '--json', '--paths', 'CHANGELOG.md', 'src/ok.ts'])).toBe(1);
      const text = out.mock.calls.map(call => String(call[0])).join('');
      expect(JSON.parse(text).refusals).toMatchObject([{ path: 'CHANGELOG.md', rule: 'changelog-singleton' }]);
      expect(await cmdFleet(['edit-collisions', '--paths', 'src/a.ts', 'src/b.ts'])).toBe(0);
    } finally {
      out.mockRestore();
      if (had) Object.defineProperty(process.stdin, 'isTTY', { configurable: true, writable: true, value: original });
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});
