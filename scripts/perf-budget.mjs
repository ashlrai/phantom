#!/usr/bin/env node
/**
 * scripts/perf-budget.mjs — CLI latency regression budget.
 *
 * Times a small set of cold-path commands — `phm --version`, `phm status`,
 * `phm doctor` and a warm `phantom` wrapper call — and fails when the median
 * exceeds the committed budget. Budgets live in perf/budgets.json as baseline
 * medians plus a headroom factor (default +20%), so the file records what the
 * tool measured and the check stays honest about machine-to-machine spread.
 *
 * hyperfine is the primary timer (same methodology as docs/perf research:
 * --warmup, --runs, CI=1 NO_COLOR=1). When hyperfine is absent the script
 * falls back to a built-in spawn timer so the check still runs locally and
 * in tests; the runner used is printed in the report. `--runner` pins one.
 *
 * Targets may declare `requires_bin` / `requires_files` preflights. A missing
 * preflight marks the target `error` (exit 2, environment problem — not a
 * regression) unless the target is `optional`, which makes it `skip`. This
 * is how the `phantom` wrapper stays advisory on machines without it, and how
 * a missing dist/ build reports setup failure instead of a fast fraudulent
 * pass from an immediate non-zero exit.
 *
 * The check is designed to run as a NON-REQUIRED CI job: it must never gate
 * merges. Locally it is also useful before/after startup-path changes.
 *
 * Usage:
 *   node scripts/perf-budget.mjs                          # committed budgets, auto runner
 *   node scripts/perf-budget.mjs --runner hyperfine       # require hyperfine
 *   node scripts/perf-budget.mjs --runner node --runs 5   # built-in timer
 *   node scripts/perf-budget.mjs --home "$(mktemp -d)"    # scratch HOME/ASHLR_HOME
 *   node scripts/perf-budget.mjs --only phm-version,phm-doctor
 *   node scripts/perf-budget.mjs --require-optional       # missing phantom => error
 *   node scripts/perf-budget.mjs --update-baseline        # refresh baseline_ms in place
 *   node scripts/perf-budget.mjs --json                   # machine-readable report
 *
 * Exit: 0 every required target within budget, 1 regression, 2 usage /
 * environment / measurement error (including a missing required tool).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BUDGETS = 'perf/budgets.json';
const DEFAULT_TOLERANCE = 0.2;
const DEFAULT_WARMUP = 2;
const DEFAULT_RUNS = 8;
const RUN_TIMEOUT_MS = 60_000;
const MEASURE_TIMEOUT_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Args / budgets
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    budgets: DEFAULT_BUDGETS,
    runner: 'auto',
    warmup: undefined,
    runs: undefined,
    home: undefined,
    only: undefined,
    json: false,
    requireOptional: false,
    updateBaseline: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = (label) => {
      if (i + 1 >= argv.length) throw new Error(`${label} needs a value`);
      i += 1;
      return argv[i];
    };
    if (arg === '--budgets') args.budgets = take(arg);
    else if (arg === '--runner') args.runner = take(arg);
    else if (arg === '--warmup') args.warmup = count(take(arg), arg);
    else if (arg === '--runs') args.runs = count(take(arg), arg);
    else if (arg === '--home') args.home = take(arg);
    else if (arg === '--only') args.only = take(arg).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--json') args.json = true;
    else if (arg === '--require-optional') args.requireOptional = true;
    else if (arg === '--update-baseline') args.updateBaseline = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['auto', 'hyperfine', 'node'].includes(args.runner)) {
    throw new Error(`--runner must be auto|hyperfine|node, got "${args.runner}"`);
  }
  return args;
}

function count(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw new Error(`${label} needs an integer 0..1000`);
  return n;
}

/**
 * Load and normalize a budgets file. Throws with a precise message on any
 * schema violation — a malformed budget must never silently pass.
 */
export function loadBudgets(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read budgets ${path}: ${err.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`budgets ${path}: top level must be an object`);
  }
  if (raw.schema !== 'ashlr.perf-budgets.v1') {
    throw new Error(`budgets ${path}: schema must be "ashlr.perf-budgets.v1"`);
  }
  const tolerance = numberField(raw.tolerance, 'tolerance', 0, 10) ?? DEFAULT_TOLERANCE;
  const defaults = raw.defaults === undefined ? {} : raw.defaults;
  if (typeof defaults !== 'object' || defaults === null) {
    throw new Error('budgets: defaults must be an object');
  }
  const warmup = numberField(defaults.warmup, 'defaults.warmup', 0, 100) ?? DEFAULT_WARMUP;
  const runs = numberField(defaults.runs, 'defaults.runs', 1, 500) ?? DEFAULT_RUNS;
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new Error(`budgets ${path}: targets must be a non-empty array`);
  }
  const seen = new Set();
  const targets = raw.targets.map((t, index) => {
    const at = `targets[${index}]`;
    if (typeof t !== 'object' || t === null) throw new Error(`${at}: must be an object`);
    if (typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(t.id)) {
      throw new Error(`${at}.id: must be a lowercase slug string`);
    }
    if (seen.has(t.id)) throw new Error(`${at}.id: duplicate "${t.id}"`);
    seen.add(t.id);
    if (typeof t.command !== 'string' || t.command.trim() === '') {
      throw new Error(`${at}.command: must be a non-empty string`);
    }
    const baselineMs = numberField(t.baseline_ms, `${at}.baseline_ms`, 0.001, 600_000);
    if (baselineMs === undefined) throw new Error(`${at}.baseline_ms: required (milliseconds)`);
    return {
      id: t.id,
      description: typeof t.description === 'string' ? t.description : undefined,
      command: t.command,
      baselineMs,
      tolerance: numberField(t.tolerance, `${at}.tolerance`, 0, 10) ?? tolerance,
      optional: t.optional === true,
      requiresBin: typeof t.requires_bin === 'string' ? t.requires_bin : undefined,
      requiresFiles: Array.isArray(t.requires_files) ? t.requires_files.filter((f) => typeof f === 'string') : [],
      warmup: numberField(t.warmup, `${at}.warmup`, 0, 100) ?? warmup,
      runs: numberField(t.runs, `${at}.runs`, 1, 500) ?? runs,
    };
  });
  return { tolerance, defaults: { warmup, runs }, targets, measured: raw.measured, path };
}

function numberField(value, label, min, max) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label}: must be a number ${min}..${max}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Preflight + runners
// ---------------------------------------------------------------------------

function onPath(bin, env) {
  const tool = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(tool, [bin], { stdio: 'ignore', env, timeout: 10_000 }).status === 0;
}

function preflight(target, { env, requireOptional }) {
  if (target.requiresBin && !onPath(target.requiresBin, env)) {
    const why = `requires_bin "${target.requiresBin}" is not on PATH`;
    return target.optional && !requireOptional ? { status: 'skip', why } : { status: 'error', why };
  }
  const missing = target.requiresFiles.filter((f) => !existsSync(join(repoRoot, f)));
  if (missing.length > 0) {
    const why = `requires_files missing: ${missing.join(', ')} (run npm run build first)`;
    return target.optional && !requireOptional ? { status: 'skip', why } : { status: 'error', why };
  }
  return { status: 'ok' };
}

export function resolveRunner(requested, env = process.env) {
  if (requested === 'node') return 'node';
  if (onPath('hyperfine', env)) return 'hyperfine';
  if (requested === 'hyperfine') {
    throw new Error('--runner hyperfine requested but hyperfine is not on PATH');
  }
  return 'node';
}

export function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarize(timesMs) {
  const sorted = [...timesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    runs: sorted.length,
    median_ms: median(sorted),
    mean_ms: sorted.length ? sum / sorted.length : NaN,
    min_ms: sorted[0],
    max_ms: sorted[sorted.length - 1],
  };
}

/**
 * Time `target.command` with hyperfine. One target per invocation keeps the
 * per-command env and reporting simple. `-i` keeps timing commands that exit
 * non-zero (e.g. `doctor` on a fresh HOME); the exit codes are still reported
 * so a run of pure failures is visible instead of a silent "fast" pass.
 */
function measureHyperfine(target, { env, cwd }) {
  const out = mkdtempSync(join(tmpdir(), 'perf-budget-hf-'));
  const outFile = join(out, 'result.json');
  try {
    const res = spawnSync('hyperfine', [
      '--style', 'none',
      '--ignore-failure',
      '--warmup', String(target.warmup),
      '--runs', String(target.runs),
      '--export-json', outFile,
      '--command-name', target.id,
      target.command,
    ], { env, cwd, encoding: 'utf8', timeout: MEASURE_TIMEOUT_MS });
    if (res.error) return { error: `hyperfine spawn failed: ${res.error.message}` };
    if (res.status !== 0) {
      return { error: `hyperfine exited ${res.status}: ${(res.stderr || res.stdout || '').trim().slice(0, 400)}` };
    }
    const result = JSON.parse(readFileSync(outFile, 'utf8')).results?.[0];
    if (!result || !Array.isArray(result.times) || result.times.length === 0) {
      return { error: 'hyperfine produced no timing results' };
    }
    return {
      stats: summarize(result.times.map((s) => s * 1000)),
      exitCodes: result.exit_codes ?? [],
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Built-in timer: `sh -c <command>` per run, warmup runs untimed. */
function measureNode(target, { env, cwd }) {
  const times = [];
  const exitCodes = [];
  for (let i = 0; i < target.warmup + target.runs; i += 1) {
    const started = performance.now();
    const res = spawnSync(target.command, {
      shell: true, env, cwd, stdio: 'ignore', timeout: RUN_TIMEOUT_MS,
    });
    const elapsed = performance.now() - started;
    if (res.error && res.error.code === 'ETIMEDOUT') {
      return { error: `command exceeded ${RUN_TIMEOUT_MS} ms timeout` };
    }
    if (res.error) return { error: `command spawn failed: ${res.error.message}` };
    exitCodes.push(res.status);
    if (i >= target.warmup) times.push(elapsed);
  }
  return { stats: summarize(times), exitCodes };
}

const MEASURERS = { hyperfine: measureHyperfine, node: measureNode };

// ---------------------------------------------------------------------------
// Evaluation + reporting
// ---------------------------------------------------------------------------

export function budgetMs(target) {
  return target.baselineMs * (1 + target.tolerance);
}

function evaluate(measurement, target) {
  if (measurement.error) return { status: 'error', why: measurement.error };
  const limit = budgetMs(target);
  const medianMs = measurement.stats.median_ms;
  return {
    status: medianMs <= limit ? 'pass' : 'fail',
    stats: measurement.stats,
    exitCodes: measurement.exitCodes,
    budget_ms: limit,
    delta_pct: ((medianMs - limit) / limit) * 100,
  };
}

function fmt(ms) {
  return ms === undefined || Number.isNaN(ms) ? '—' : `${ms.toFixed(1)}ms`;
}

function printTable(results) {
  const idWidth = Math.max(6, ...results.map((r) => r.id.length));
  for (const r of results) {
    const head = `${r.status.toUpperCase().padEnd(5)} ${r.id.padEnd(idWidth)}`;
    if (r.status === 'pass' || r.status === 'fail') {
      console.log(
        `${head} median ${fmt(r.stats.median_ms).padStart(9)} / budget ${fmt(r.budget_ms).padStart(9)}`
        + ` (baseline ${fmt(r.baseline_ms)}, +${Math.round(r.tolerance * 100)}%)`
        + `  n=${r.stats.runs} min ${fmt(r.stats.min_ms)} max ${fmt(r.stats.max_ms)}`,
      );
    } else {
      console.log(`${head} ${r.why ?? ''}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function runAll(spec, args, { runner, env, cwd }) {
  const wanted = args.only ? spec.targets.filter((t) => args.only.includes(t.id)) : spec.targets;
  if (wanted.length === 0) {
    throw new Error(`--only matched no targets (have: ${spec.targets.map((t) => t.id).join(', ')})`);
  }
  const measure = MEASURERS[runner];
  return wanted.map((target) => {
    const pre = preflight(target, { env, requireOptional: args.requireOptional });
    const base = {
      id: target.id,
      command: target.command,
      baseline_ms: target.baselineMs,
      tolerance: target.tolerance,
      optional: target.optional,
    };
    if (pre.status !== 'ok') return { ...base, ...pre };
    return { ...base, ...evaluate(measure(target, { env, cwd }), target) };
  });
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`perf-budget: ${err.message}`);
    console.error('Usage: node scripts/perf-budget.mjs [--budgets FILE] [--runner auto|hyperfine|node] [--warmup N] [--runs N] [--home DIR] [--only a,b] [--require-optional] [--update-baseline] [--json]');
    return 2;
  }
  if (args.help) {
    console.log('Usage: node scripts/perf-budget.mjs [--budgets FILE] [--runner auto|hyperfine|node] [--warmup N] [--runs N] [--home DIR] [--only a,b] [--require-optional] [--update-baseline] [--json]');
    return 0;
  }

  const budgetsPath = resolve(repoRoot, args.budgets);
  let spec;
  try {
    spec = loadBudgets(budgetsPath);
  } catch (err) {
    console.error(`perf-budget: ${err.message}`);
    return 2;
  }
  if (args.warmup !== undefined || args.runs !== undefined) {
    for (const t of spec.targets) {
      if (args.warmup !== undefined) t.warmup = args.warmup;
      if (args.runs !== undefined) t.runs = args.runs;
    }
  }

  const env = {
    ...process.env,
    CI: '1',
    NO_COLOR: '1',
    ...(args.home
      ? { HOME: args.home, USERPROFILE: args.home, ASHLR_HOME: join(args.home, '.ashlr') }
      : {}),
  };

  let runner;
  try {
    runner = resolveRunner(args.runner, env);
  } catch (err) {
    console.error(`perf-budget: ${err.message}`);
    return 2;
  }
  if (args.runner === 'auto' && runner === 'node' && !args.json) {
    console.error('perf-budget: hyperfine not found; using the built-in node timer (--runner hyperfine to require it)');
  }

  let results;
  try {
    results = runAll(spec, args, { runner, env, cwd: repoRoot });
  } catch (err) {
    console.error(`perf-budget: ${err.message}`);
    return 2;
  }

  if (args.updateBaseline) {
    const file = JSON.parse(readFileSync(budgetsPath, 'utf8'));
    for (const r of results) {
      const t = file.targets.find((x) => x.id === r.id);
      if (t && (r.status === 'pass' || r.status === 'fail')) {
        t.baseline_ms = Math.round(r.stats.median_ms * 10) / 10;
      }
    }
    file.measured = {
      ...(file.measured ?? {}),
      updated: new Date().toISOString().slice(0, 10),
      runner,
      node: process.version,
    };
    writeFileSync(budgetsPath, `${JSON.stringify(file, null, 2)}\n`);
  }

  const failed = results.filter((r) => r.status === 'fail');
  const errored = results.filter((r) => r.status === 'error');
  const ok = failed.length === 0 && errored.length === 0;

  if (args.json) {
    console.log(JSON.stringify({
      schema: 'ashlr.perf-budget-report.v1',
      ok,
      runner,
      budgets: args.budgets,
      results: results.map((r) => ({
        ...r,
        stats: r.stats && {
          runs: r.stats.runs,
          median_ms: round(r.stats.median_ms),
          mean_ms: round(r.stats.mean_ms),
          min_ms: round(r.stats.min_ms),
          max_ms: round(r.stats.max_ms),
        },
        budget_ms: r.budget_ms === undefined ? undefined : round(r.budget_ms),
        delta_pct: r.delta_pct === undefined ? undefined : round(r.delta_pct),
      })),
    }, null, 2));
  } else {
    printTable(results);
    const passed = results.filter((r) => r.status === 'pass').length;
    const skipped = results.filter((r) => r.status === 'skip').length;
    console.log(
      `perf-budget (${runner}): ${passed} passed, ${failed.length} over budget,`
      + ` ${errored.length} errors, ${skipped} skipped — ${ok ? 'OK' : 'FAILED'}`,
    );
  }
  return errored.length > 0 ? 2 : failed.length > 0 ? 1 : 0;
}

function round(v) {
  return v === undefined || Number.isNaN(v) ? undefined : Math.round(v * 10) / 10;
}

// Import-safe: tests import loadBudgets/median/etc. without timing anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
