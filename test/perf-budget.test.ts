/**
 * Tests for scripts/perf-budget.mjs.
 *
 * Hermetic: every fixture budgets file is written under os.tmpdir() and the
 * script runs as a real subprocess against the built-in `node` runner, so no
 * hyperfine install, dist build or phantom binary is needed. The regression
 * fixture carries a deliberate `setTimeout` sleep: its median is far above
 * the tiny baseline, proving the check actually fails on a slow command
 * rather than only on schema violations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadBudgets, median, summarize, budgetMs } from '../scripts/perf-budget.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/perf-budget.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'perf-budget-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function budgetsFile(targets: unknown[], extra: Record<string, unknown> = {}): string {
  const path = join(dir, `budgets-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({
    schema: 'ashlr.perf-budgets.v1',
    tolerance: 0.2,
    defaults: { warmup: 1, runs: 3 },
    targets,
    ...extra,
  }));
  return path;
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('perf-budget budget math', () => {
  it('median of odd and even samples', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(summarize([10, 30, 20])).toMatchObject({ runs: 3, median_ms: 20, min_ms: 10, max_ms: 30, mean_ms: 20 });
  });

  it('budgetMs applies baseline medians plus tolerance', () => {
    expect(budgetMs({ baselineMs: 100, tolerance: 0.2 })).toBe(120);
    expect(budgetMs({ baselineMs: 100, tolerance: 0.5 })).toBe(150);
  });
});

describe('perf-budget budgets schema', () => {
  it('accepts the committed perf/budgets.json', () => {
    const spec = loadBudgets(join(REPO, 'perf/budgets.json'));
    expect(spec.tolerance).toBeCloseTo(0.2);
    const ids = spec.targets.map((t) => t.id);
    expect(ids).toEqual(['phm-version', 'phm-status', 'phm-doctor', 'phantom-wrapper-warm']);
    for (const t of spec.targets) {
      expect(t.baselineMs).toBeGreaterThan(0);
      expect(t.command.length).toBeGreaterThan(0);
      expect(budgetMs(t)).toBeGreaterThan(t.baselineMs);
    }
    const phantom = spec.targets.find((t) => t.id === 'phantom-wrapper-warm')!;
    expect(phantom.optional).toBe(true);
    expect(phantom.requiresBin).toBe('phantom');
    // The phm targets time the built wrapper, so a missing dist/ must error,
    // never fast-pass on an immediate non-zero exit.
    for (const id of ['phm-version', 'phm-status', 'phm-doctor']) {
      const t = spec.targets.find((x) => x.id === id)!;
      expect(t.requiresFiles).toContain('dist/cli/index.js');
      expect(t.command).toContain('bin/ashlr');
    }
  });

  it('rejects a malformed budgets file', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ schema: 'ashlr.perf-budgets.v1', targets: [{ id: 'x', command: 'true' }] }));
    const r = run(['--budgets', bad, '--runner', 'node']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('baseline_ms');
  });

  it('rejects an unknown schema', () => {
    const bad = budgetsFile([], { schema: 'nope' });
    const r = run(['--budgets', bad, '--runner', 'node']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('schema');
  });
});

describe('perf-budget check outcomes', () => {
  it('fails when a fixture command deliberately sleeps past its budget', () => {
    const budgets = budgetsFile([
      {
        id: 'slow-target',
        command: `${process.execPath} -e "setTimeout(() => {}, 250)"`,
        baseline_ms: 20,
        warmup: 0,
        runs: 2,
      },
      {
        id: 'fast-target',
        command: `${process.execPath} -e ""`,
        baseline_ms: 30_000,
        warmup: 0,
        runs: 1,
      },
    ]);
    const r = run(['--budgets', budgets, '--runner', 'node']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+slow-target/);
    expect(r.stdout).toMatch(/PASS\s+fast-target/);
    expect(r.stdout).toContain('over budget');
  });

  it('passes when every required target is within budget', () => {
    const budgets = budgetsFile([
      { id: 'quick', command: `${process.execPath} -e ""`, baseline_ms: 30_000, warmup: 0, runs: 2 },
    ]);
    const r = run(['--budgets', budgets, '--runner', 'node']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  it('reports JSON with per-target medians and budgets', () => {
    const budgets = budgetsFile([
      { id: 'slow-json', command: `${process.execPath} -e "setTimeout(() => {}, 200)"`, baseline_ms: 10, warmup: 0, runs: 2 },
    ]);
    const r = run(['--budgets', budgets, '--runner', 'node', '--json']);
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.schema).toBe('ashlr.perf-budget-report.v1');
    expect(report.ok).toBe(false);
    expect(report.runner).toBe('node');
    expect(report.results[0]).toMatchObject({ id: 'slow-json', status: 'fail', baseline_ms: 10 });
    expect(report.results[0].stats.median_ms).toBeGreaterThan(report.results[0].budget_ms);
  });
});

describe('perf-budget preflight', () => {
  const missingBin = 'perf-budget-no-such-bin-9q7';

  it('skips optional targets whose requires_bin is absent', () => {
    const budgets = budgetsFile([
      {
        id: 'phantom-wrapper-warm',
        command: `${missingBin} --version`,
        baseline_ms: 50,
        optional: true,
        requires_bin: missingBin,
        warmup: 0,
        runs: 1,
      },
    ]);
    const r = run(['--budgets', budgets, '--runner', 'node']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/SKIP\s+phantom-wrapper-warm/);
    expect(r.stdout).toContain('skipped');
  });

  it('errors on a missing required binary, and on optional with --require-optional', () => {
    const budgets = budgetsFile([
      { id: 'need-bin', command: `${missingBin} x`, baseline_ms: 50, requires_bin: missingBin, warmup: 0, runs: 1 },
      { id: 'opt-bin', command: `${missingBin} x`, baseline_ms: 50, optional: true, requires_bin: missingBin, warmup: 0, runs: 1 },
    ]);
    const relaxed = run(['--budgets', budgets, '--runner', 'node']);
    expect(relaxed.status).toBe(2);
    expect(relaxed.stdout).toMatch(/ERROR\s+need-bin/);
    expect(relaxed.stdout).toMatch(/SKIP\s+opt-bin/);
    const strict = run(['--budgets', budgets, '--runner', 'node', '--require-optional']);
    expect(strict.status).toBe(2);
    expect(strict.stdout).toMatch(/ERROR\s+opt-bin/);
  });

  it('errors when requires_files are missing instead of fast-passing', () => {
    const budgets = budgetsFile([
      {
        id: 'needs-dist',
        command: `${process.execPath} -e "process.exit(1)"`,
        baseline_ms: 50,
        requires_files: ['dist/definitely-not-built-9q7.js'],
        warmup: 0,
        runs: 1,
      },
    ]);
    const r = run(['--budgets', budgets, '--runner', 'node']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/ERROR\s+needs-dist/);
    expect(r.stdout).toContain('requires_files');
  });
});

describe('perf-budget selection', () => {
  it('--only runs the named subset', () => {
    const budgets = budgetsFile([
      { id: 'one', command: `${process.execPath} -e ""`, baseline_ms: 30_000, warmup: 0, runs: 1 },
      { id: 'two', command: `${process.execPath} -e ""`, baseline_ms: 30_000, warmup: 0, runs: 1 },
    ]);
    const r = run(['--budgets', budgets, '--runner', 'node', '--only', 'two']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('two');
    expect(r.stdout).not.toMatch(/\bone\b/);
  });

  it('--only with an unknown id is a usage error', () => {
    const budgets = budgetsFile([
      { id: 'one', command: 'true', baseline_ms: 30_000 },
    ]);
    const r = run(['--budgets', budgets, '--runner', 'node', '--only', 'ghost']);
    expect(r.status).toBe(2);
  });
});
