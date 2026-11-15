/**
 * RQ-PHX-QUEUELINTORIGINAL247S — READY field-by-field diagnostic matrix preserved from PR #3230.
 *
 * Source: ashlrai/phantom PR #3230 head ef9d7e6d9b424851f7338874ed6334d290d94786,
 * test/fleet-queue-lint.test.ts and test/fixtures/fleet-queue-lint/router-queue.md.
 * On that head lintQueue lived in src/cli/fleet-queue-lint.ts, took the router
 * text only, and returned {line, id, missing}[]; cmdFleetQueueLint took an
 * injected reader and exited 1 on any finding. On master the core moved to
 * src/core/queue/lint.ts returning the queue.lint.v1 buckets, cmdFleetQueueLint
 * takes a deps object ({home, runsDir, now, out, error}) and reads the real
 * queue files, and diagnostic findings no longer force exit 1 — only unavailable
 * inputs do. This file replays the original scenarios against the current
 * contracts; it does not resurrect the old signature, schema or exit policy.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lintQueue } from '../src/core/queue/lint.js';
import { cmdFleetQueueLint } from '../src/cli/fleet-queue-lint.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const NOW = Date.parse('2026-01-01T04:00:00Z');

// Inline port of test/fixtures/fleet-queue-lint/router-queue.md @ ef9d7e6d.
const ROUTER = [
  '# Queue',
  '- READY RQ-VALID (P1, pool=codex-personal, tier=work, repo=phantom): Check: details',
  '- READY RQ- (P1, pool=x, tier=work, repo=phantom): goal',
  '- READY RQ-PRIORITY (pool=x, tier=work, repo=phantom): goal',
  '- READY RQ-POOL (P1, pool=, tier=work, repo=phantom): goal',
  '- READY RQ-TIER (P1, pool=x, repo=phantom): goal',
  '- READY RQ-REPO (P1, pool=x, tier=work): goal',
  '- READY RQ-GOAL (P1, pool=x, tier=work, repo=phantom):',
  '- DONE RQ-IGNORE',
  '- READY RQ-OUTSIDE (pool=x, tier=work, repo=phantom): P1',
  '',
].join('\n');

// First missing field per malformed READY line, in contract order.
const EXPECTED_MISSING = [
  [4, 'RQ-PRIORITY', 'Missing priority'],
  [5, 'RQ-POOL', 'Missing pool'],
  [6, 'RQ-TIER', 'Missing tier'],
  [7, 'RQ-REPO', 'Missing repo'],
  [8, 'RQ-GOAL', 'Missing goal'],
  [10, 'RQ-OUTSIDE', 'Missing priority'],
] as const;

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

async function scratch(): Promise<{ home: string; runsDir: string }> {
  const home = await mkdtemp(join(tmpdir(), 'queue-lint-247s-'));
  dirs.push(home);
  return { home, runsDir: join(home, 'runs') };
}

async function queueDir(router: string, status?: string): Promise<{ home: string; runsDir: string }> {
  const { home, runsDir } = await scratch();
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await writeFile(join(runsDir, 'queue', 'router-queue.md'), router);
  await writeFile(join(runsDir, 'queue', 'ready.tsv'), '');
  if (status !== undefined) await writeFile(join(runsDir, 'queue', 'status.json'), status);
  return { home, runsDir };
}

describe('PR #3230 READY diagnostic matrix (preserved)', () => {
  it('reports exactly one first-missing-field finding per malformed READY line', async () => {
    const { home, runsDir } = await scratch();
    const report = await lintQueue(ROUTER, '', runsDir, home, NOW);
    expect(report.schema).toBe('queue.lint.v1');
    expect(report.missingFields.map(f => [f.line, f.id, f.reason])).toEqual(EXPECTED_MISSING);
    // Original line 3 (`- READY RQ- ...`) expected missing 'id'. The current
    // READY identifier regex accepts `RQ` there and the metadata is complete,
    // so the line yields no missing-field finding; missing-id coverage is
    // asserted explicitly below rather than weakened silently.
    expect(report.missingFields.some(f => f.line === 3)).toBe(false);
  });

  it('maps the original missing-id scenario onto the current identifier contract', async () => {
    const { home, runsDir } = await scratch();
    const report = await lintQueue(
      '- READY (P1, pool=x, tier=work, repo=phantom): goal\n'
      + '- READY \n'
      + '- READY RQ-FULL (P1, pool=x, tier=work, repo=phantom): goal\n',
      '', runsDir, home, NOW);
    expect(report.missingFields).toEqual([
      { line: 1, id: null, reason: 'Missing id' },
      { line: 2, id: null, reason: 'Missing id' },
    ]);
  });

  it('keeps first-missing-field order for missing colon, blank pool and outside-parens priority', async () => {
    const { home, runsDir } = await scratch();
    const report = await lintQueue([
      '- READY RQ-NOCOLON (P1, pool=x, tier=work, repo=phantom) goal',
      '- READY RQ-POOL (P1, pool=, tier=work, repo=phantom): goal',
      '- READY RQ-OUTSIDE (pool=x, tier=work, repo=phantom): P1',
      '- READY RQ-MULTI (pool=x, tier=work): goal',
    ].join('\n'), '', runsDir, home, NOW);
    expect(report.missingFields.map(f => [f.line, f.id, f.reason])).toEqual([
      [1, 'RQ-NOCOLON', 'Missing goal'],
      [2, 'RQ-POOL', 'Missing pool'],
      [3, 'RQ-OUTSIDE', 'Missing priority'],
      [4, 'RQ-MULTI', 'Missing priority'],
    ]);
  });

  it('accepts a valid P0 FLAGSHIP line with CRLF and ignores DONE/comment lines', async () => {
    const { home, runsDir } = await scratch();
    const report = await lintQueue(
      '# comment\r\n- DONE RQ-IGNORE\r\n- READY RQ-OK (P0 FLAGSHIP, pool=x, tier=work, repo=phantom): goal\r\n',
      '', runsDir, home, NOW);
    expect(report.missingFields).toEqual([]);
  });

  it('prints text and JSON findings against real queue files and preserves input bytes', async () => {
    const { home, runsDir } = await queueDir(ROUTER, JSON.stringify({ invalid_queue_lines: 3 }));
    const paths = ['router-queue.md', 'ready.tsv', 'status.json'].map(f => join(runsDir, 'queue', f));
    const before = await Promise.all(paths.map(p => readFile(p, 'utf8')));
    const deps = { home, runsDir, now: NOW };

    const jsonOut: string[] = [];
    expect(await cmdFleetQueueLint(['--json'], { ...deps, out: s => jsonOut.push(s) })).toBe(0);
    const report = JSON.parse(jsonOut[0]!);
    expect(report.schema).toBe('queue.lint.v1');
    expect(report.missingFields.map((f: { line: number; id: string | null; reason: string }) => [f.line, f.id, f.reason])).toEqual(EXPECTED_MISSING);
    expect(report.invalid_queue_lines).toBe(3);
    expect(report.errors).toEqual([]);

    const textOut: string[] = [];
    expect(await cmdFleetQueueLint([], { ...deps, out: s => textOut.push(s) })).toBe(0);
    for (const [line, id, reason] of EXPECTED_MISSING) {
      expect(textOut).toContain(`Missing READY field: line ${line}, ${id}: ${reason}`);
    }
    expect(textOut).toContain('Dispatcher invalid lines: 3');
    expect(textOut).not.toContain('No queue issues found.');

    expect(await Promise.all(paths.map(p => readFile(p, 'utf8')))).toEqual(before);
  });

  it('keeps a dispatcher-only invalid count visible without inventing local findings', async () => {
    const clean = '- READY RQ-OK (P0 FLAGSHIP, pool=x, tier=work, repo=phantom): goal queued=2026-01-01T03:30:00Z\n';
    const { home, runsDir } = await queueDir(clean, JSON.stringify({ invalid_queue_lines: 3 }));
    const deps = { home, runsDir, now: NOW };

    const jsonOut: string[] = [];
    expect(await cmdFleetQueueLint(['--json'], { ...deps, out: s => jsonOut.push(s) })).toBe(0);
    const report = JSON.parse(jsonOut[0]!);
    for (const key of ['missingFields', 'duplicates', 'invalid', 'old', 'unknownAge']) expect(report[key]).toEqual([]);
    expect(report.invalid_queue_lines).toBe(3);
    expect(report.errors).toEqual([]);

    const textOut: string[] = [];
    expect(await cmdFleetQueueLint([], { ...deps, out: s => textOut.push(s) })).toBe(0);
    expect(textOut).toEqual(['Dispatcher invalid lines: 3']);
  });

  it('preserves missing-field findings when the dispatcher count is unavailable', async () => {
    const { home, runsDir } = await queueDir(ROUTER);
    const statusPath = join(runsDir, 'queue', 'status.json');
    for (const status of [undefined, 'broken', '{}', '{"invalid_queue_lines":-1}', '{"invalid_queue_lines":1.5}', '{"invalid_queue_lines":"3"}']) {
      if (status === undefined) await rm(statusPath, { force: true });
      else await writeFile(statusPath, status);
      const out: string[] = [];
      expect(await cmdFleetQueueLint(['--json'], { home, runsDir, now: NOW, out: s => out.push(s) })).toBe(1);
      const report = JSON.parse(out[0]!);
      expect(report.invalid_queue_lines).toBeNull();
      expect(report.errors).toEqual(['Dispatcher count unavailable']);
      expect(report.missingFields.map((f: { line: number; id: string | null; reason: string }) => [f.line, f.id, f.reason])).toEqual(EXPECTED_MISSING);
    }
  });

  it('does not print goal text or reader exceptions and keeps the subcommand loader wired', async () => {
    const leaky = '- READY RQ-LEAK (P1, pool=x, tier=work, repo=phantom): UNIQUE-GOAL-MARKER-7f3d\n'
      + '- READY RQ-NOGOAL (P1, pool=x, tier=work, repo=phantom):\n';
    const { home, runsDir } = await queueDir(leaky, 'broken');
    const out: string[] = [], err: string[] = [];
    const deps = { home, runsDir, now: NOW, out: (s: string) => out.push(s), error: (s: string) => err.push(s) };
    expect(await cmdFleetQueueLint(['--json'], deps)).toBe(1);
    expect(await cmdFleetQueueLint([], deps)).toBe(1);
    expect([...out, ...err].join('\n')).not.toContain('UNIQUE-GOAL-MARKER-7f3d');
    expect(out.some(line => line.includes('Missing goal'))).toBe(true);

    const bare = await mkdtemp(join(tmpdir(), 'queue-lint-bare-'));
    dirs.push(bare);
    const bareRuns = join(bare, 'runs');
    const errors: string[] = [];
    expect(await cmdFleetQueueLint(['--json'], { home: bare, runsDir: bareRuns, now: NOW, error: (s: string) => errors.push(s) })).toBe(1);
    expect(JSON.parse(errors[0]!)).toEqual({ schema: 'queue.lint.error.v1', error: 'Unable to read queue files' });
    expect(errors.join('\n')).not.toContain(bareRuns);
    expect(errors.join('\n')).not.toContain('ENOENT');

    expect(typeof (await FLEET_SUBCOMMAND_LOADERS['queue-lint']!()).cmdFleetQueueLint).toBe('function');
  });
});
