#!/usr/bin/env node
/** Run an exhaustive four-way local partition with two bounded workers.
 * Explicit selectors reuse the same general and isolated membership in CI.
 * Each test-ci wrapper owns a private HOME and its Vitest process tree. Keep
 * at most two shards active, each with one worker, so real-I/O fixtures do not
 * contend with two other local shards for their bounded startup windows.
 *
 * `--workers=N` instead splits the general files into N shards balanced by the
 * measured per-file durations in test/helpers/test-durations.json and runs all
 * N at once (one worker each), then the isolated cases two at a time.
 */
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { assertExactFilters, parseInventory, planShards, readDurations } from './test-shard-plan.mjs';

const runner = fileURLToPath(new URL('./test-ci.mjs', import.meta.url));
const shards = [1, 2, 3, 4];
const args = process.argv.slice(2);
const generalSelector = args.length === 1 ? /^--general-shard=([1-4])\/4$/.exec(args[0]) : null;
const isolatedOnly = args.length === 1 && args[0] === '--isolated-only';
const workersSelector = args.length === 1 ? /^--workers=([1-8])$/.exec(args[0]) : null;
if (args.length > 0 && !generalSelector && !isolatedOnly && !workersSelector) {
  console.error('Usage: test-ci-sharded.mjs [--general-shard=N/4 | --isolated-only | --workers=W] (N=1..4, W=1..8)');
  process.exit(2);
}
const selectedShard = generalSelector ? Number(generalSelector[1]) : null;
const balancedWorkers = workersSelector ? Number(workersSelector[1]) : null;
// Hosted CI may run the isolated suites two at a time. They mostly wait on real
// child processes, so a pair fits one runner, and each suite still gets its own
// home and single worker with every bounded deadline unchanged. Locally they
// stay serial unless asked or balanced over four or more workers; any other
// value is refused.
const isolatedConcurrencyInput = process.env.ASHLR_TEST_CI_ISOLATED_CONCURRENCY ??
  (balancedWorkers !== null && balancedWorkers >= 4 ? '2' : '1');
if (isolatedConcurrencyInput !== '1' && isolatedConcurrencyInput !== '2') {
  console.error('ASHLR_TEST_CI_ISOLATED_CONCURRENCY must be 1 or 2.');
  process.exit(2);
}
const isolatedConcurrency = Number(isolatedConcurrencyInput);
const reportInput = process.env.ASHLR_TEST_CI_REPORT_DIRECTORY;
let reportDirectory = null;
if (reportInput !== undefined) {
  try {
    if (!isAbsolute(reportInput) || realpathSync(reportInput) !== reportInput || typeof process.getuid !== 'function') {
      throw new Error('invalid report directory');
    }
    const before = lstatSync(reportInput);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid() ||
      (before.mode & 0o7777) !== 0o700 || readdirSync(reportInput).length !== 0) {
      throw new Error('invalid report directory');
    }
    const after = lstatSync(reportInput);
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino ||
      before.uid !== after.uid || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs || realpathSync(reportInput) !== reportInput) {
      throw new Error('changed report directory');
    }
    reportDirectory = reportInput;
  } catch {
    console.error('Report directory must be empty, canonical, owned, and private (0700) on POSIX.');
    process.exit(2);
  }
}
function reportArgs(name) {
  return reportDirectory === null ? [] : [
    '--reporter=default', '--reporter=json', `--outputFile.json=${join(reportDirectory, name)}`,
  ];
}
// Vitest 4 inline project caps override the root --maxWorkers value. Its
// forwarded fileParallelism override forces each project's workers to one,
// preserving this local runner's intended concurrency in both test lanes.
// These suites exercise real Git, sandbox, ledger, and foreground CLI work with
// bounded deadlines. Running them beside two other real-I/O shards can consume
// those deadlines without testing the behavior the cases are meant to prove.
const isolatedSuites = [
  'test/m342.dispatch-production-ledger.test.ts',
  // Preserve all 200 real journal commits and their deadline without a competing
  // local shard consuming the same filesystem/ACL process capacity.
  'test/m395.effect-terminal-retention.test.ts',
  'test/m446.external-skill-git-capture.test.ts',
  'test/resource-engineering-setup-acceptance.test.ts',
  'test/resource-engineering-supervisor-acceptance.test.ts',
  // Keep all admission/replay/expiry cases and their real Git/delivery work in
  // one isolated local home, preserving every existing bounded deadline.
  'test/resource-engineering-supervisor-admission-acceptance.test.ts',
  // Preserve bounded HTTP admission checks without a competing local shard's
  // Git and private-store filesystem work consuming the request deadlines.
  'test/resource-console-engineering-acceptance.test.ts',
  'test/universe-firm-engineering-control.test.ts',
  // The same real evaluator/Git/delivery recovery path has bounded allowances;
  // preserve all cases without a competing local real-I/O shard.
  'test/universe-engineering-handoff-recovery.test.ts',
  // A concurrent local full run failed a bounded campaign trial; the isolated
  // whole file passed. Retain all 17 cases and deadlines in one fresh home.
  'test/universe-campaign-integration.test.ts',
  // Preserve all successor quota, delivery, accounting and restart cases with
  // their original finite budgets in one fresh home after competing shards.
  'test/resource-engineering-successor-acceptance.test.ts',
  // A concurrent full run withheld delivery; the standalone whole file passed.
  // Retain all 12 supervision cases and deadlines without competing workers.
  'test/universe-supervision-integration.test.ts',
];
const isolatedAcceptance = 'test/universe-hub-marker-campaign.test.ts';
const exclusions = [...isolatedSuites, isolatedAcceptance].map((file) => `--exclude=${file}`);
const isolatedCases = [
  ...isolatedSuites.map((file) => ({ file, label: file })),
  { file: isolatedAcceptance, filter: 'automatic seed measurement: false', label: 'campaign false' },
  { file: isolatedAcceptance, filter: 'automatic seed measurement: true', label: 'campaign true' },
];
// Measured macOS seconds per isolated case (hosted run 39088914496, 10-18).
// Paired runs start the longest first so neither slot is left with the tail.
const isolatedSeconds = {
  'test/resource-engineering-setup-acceptance.test.ts': 473,
  'test/resource-engineering-successor-acceptance.test.ts': 172,
  'test/universe-firm-engineering-control.test.ts': 157,
  'test/resource-engineering-supervisor-admission-acceptance.test.ts': 133,
  'test/m342.dispatch-production-ledger.test.ts': 106,
  'campaign false': 100,
  'test/resource-engineering-supervisor-acceptance.test.ts': 98,
  'test/resource-console-engineering-acceptance.test.ts': 82,
  'test/universe-engineering-handoff-recovery.test.ts': 67,
  'test/universe-campaign-integration.test.ts': 64,
  'test/universe-supervision-integration.test.ts': 63,
  'campaign true': 60,
  'test/m446.external-skill-git-capture.test.ts': 45,
  'test/m395.effect-terminal-retention.test.ts': 29,
};
// Existing real-I/O acceptance phases describe work within a long-running case;
// enable them without changing the wrapper's child-output idle deadline. Keep
// explicit caller choices, including empty values, and leave the parent alone.
// Acceptance elapsed summaries are buffered until fixture cleanup settles.
const childEnvironment = {
  ...process.env,
  ASHLR_ENGINEERING_SETUP_PHASE_TIMING: process.env.ASHLR_ENGINEERING_SETUP_PHASE_TIMING ?? '1',
  ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING: process.env.ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING ?? '1',
  ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING: process.env.ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING ?? '1',
  ASHLR_ACCEPTANCE_PHASE_TIMING: process.env.ASHLR_ACCEPTANCE_PHASE_TIMING ?? '1',
};
// Isolated acceptance and balanced shards never use the calibration sequencer.
const isolatedEnvironment = { ...childEnvironment };
delete isolatedEnvironment.ASHLR_TEST_CI_WEIGHTED_PARTITION;
delete isolatedEnvironment.ASHLR_TEST_CI_WEIGHTED_HINTS;
const children = new Map();
let stopping = false;
let failure = 0;

function stopOthers(except) {
  if (stopping) return;
  stopping = true;
  for (const [key, child] of children) {
    if (key !== except && child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    failure ||= signal === 'SIGINT' ? 130 : 143;
    stopOthers();
  });
}

/** Run one test-ci wrapper; the first non-zero exit stops every sibling. */
function launch(key, startLabel, endLabel, runnerArgs, env) { return new Promise((resolve) => {
  const child = spawn(process.execPath, [runner, ...runnerArgs], { cwd: process.cwd(), env, stdio: 'inherit' });
  children.set(key, child);
  console.error(`[test-ci:sharded] started ${startLabel} (pid ${child.pid ?? 'unavailable'})`);
  let settled = false;
  const finish = (code, detail) => {
    if (settled) return;
    settled = true;
    console.error(`[test-ci:sharded] ${endLabel} ${detail}`);
    if (code !== 0 && !failure) {
      failure = code;
      stopOthers(key);
    }
    resolve(code);
  };
  child.once('error', (error) => finish(1, `failed to start: ${error.message}`));
  child.once('exit', (code, signal) => finish(code ?? 1, signal ? `exited via ${signal}` : `exited ${code}`));
}); }

/** Drain `order` with `concurrency` consumers, launching nothing after a failure. */
async function runPool(order, concurrency, run) {
  const queue = [...order];
  const consume = async () => {
    while (queue.length && !failure) await run(queue.shift());
  };
  await Promise.all(Array.from({ length: concurrency }, consume));
}

/** Every general file Vitest collects, from the live config rather than a glob copy. */
function collectInventory() {
  const scratch = mkdtempSync(join(tmpdir(), 'ashlr-test-ci-list-'));
  try {
    const output = join(scratch, 'list.json');
    const listed = spawnSync(process.execPath, [join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs'), 'list',
      '--filesOnly', `--json=${output}`], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 180_000,
      env: { ...isolatedEnvironment, HOME: scratch, USERPROFILE: scratch, ASHLR_HOME: join(scratch, '.ashlr') },
    });
    if (listed.status !== 0) throw new Error(`vitest list failed: ${listed.error?.message ?? listed.stderr.trim().slice(-500)}`);
    return parseInventory(JSON.parse(readFileSync(output, 'utf8')), process.cwd());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

let generalLaunches;
if (balancedWorkers !== null) {
  let plan;
  try {
    const collected = collectInventory();
    const isolatedFiles = new Set([...isolatedSuites, isolatedAcceptance]);
    const general = collected.filter((file) => !isolatedFiles.has(file));
    assertExactFilters(general, collected);
    plan = planShards(general, readDurations(), balancedWorkers);
  } catch (error) {
    console.error(`[test-ci:sharded] cannot plan balanced shards: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const estimates = plan.shards.map(({ files, estimatedMs }) => `${files.length} files ~${Math.round(estimatedMs / 1000)}s`);
  console.error(`[test-ci:sharded] balanced ${balancedWorkers} shards by measured duration: ${estimates.join(' | ')}` +
    (plan.unmeasured.length ? `; ${plan.unmeasured.length} unmeasured files estimated at ${plan.estimateMs}ms` : ''));
  // Every balanced shard gets its own slot, so all of them start together.
  generalLaunches = plan.shards.map(({ files }, index) => ({ shard: index + 1, files }));
} else {
  // Four smaller deterministic partitions aim to reduce the indivisible final tail.
  // Keep exactly two single-worker wrappers active; every general file still runs
  // once and all isolated suites retain their separate serial homes.
  generalLaunches = (isolatedOnly ? [] : selectedShard === null ? shards : [selectedShard])
    .map((shard) => ({ shard, files: null })).reverse();
}

// A full local run keeps two single-worker shards active. A selected shard runs
// alone on its machine, so its real-I/O lane gets those same two workers. The
// unit lane keeps one fork so its event-loop timing budgets see no co-tenant.
const shardWorkerArgs = selectedShard === null
  ? ['--maxWorkers=1', '--fileParallelism=false'] : ['--maxWorkers=2'];
const shardEnvironment = balancedWorkers !== null ? isolatedEnvironment : selectedShard === null
  ? childEnvironment : { ...childEnvironment, ASHLR_VITEST_UNIT_MAX_WORKERS: '1' };
const shardCount = balancedWorkers ?? shards.length;
const codes = [];
const runGeneral = async ({ shard, files }) => {
  const selector = files === null ? [`--shard=${shard}/${shardCount}`] : files;
  const report = files === null ? `general-${shard}-of-4.json` : `balanced-${shard}-of-${shardCount}.json`;
  codes[shard - 1] = await launch(shard, `${shard}/${shardCount}`, `${shard}/${shardCount}`,
    [...selector, ...shardWorkerArgs, '--bail=1', ...exclusions, ...reportArgs(report)], shardEnvironment);
};
await runPool(generalLaunches, balancedWorkers ?? 2, runGeneral);
const expectedShards = generalLaunches.map(({ shard }) => shard);
if (failure || !expectedShards.every((shard) => codes[shard - 1] === 0)) {
  process.exitCode = failure || 1;
  console.error(`[test-ci:sharded] FAIL (${codes.join(', ')})`);
} else if (selectedShard !== null) {
  console.error(`[test-ci:sharded] PASS (general ${selectedShard}/${shards.length})`);
} else {
  // Run slow real-I/O suites after the shards with no competing test workers.
  // Each gets a fresh home. The campaign's two cases also get separate homes
  // so one case's process state cannot exhaust the next delivery.
  const isolatedCodes = [];
  const runIsolated = async (index) => {
    const { file, filter, label } = isolatedCases[index];
    isolatedCodes[index] = await launch(`isolated-${label}`, `isolated acceptance ${label}`, `isolated ${label}`,
      [file, ...(filter ? ['-t', filter] : []), '--maxWorkers=1', '--fileParallelism=false', '--bail=1',
        ...reportArgs(`isolated-${String(index + 1).padStart(2, '0')}.json`)], isolatedEnvironment);
  };
  const order = isolatedCases.map((_, index) => index);
  if (isolatedConcurrency > 1) {
    const seconds = ({ file, label }) => isolatedSeconds[label === file ? file : label] ?? 0;
    order.sort((a, b) => seconds(isolatedCases[b]) - seconds(isolatedCases[a]) || a - b);
  }
  await runPool(order, isolatedConcurrency, runIsolated);
  const launched = isolatedCodes.filter((code) => code !== undefined);
  process.exitCode = failure || (launched.length === isolatedCases.length ? 0 : 1);
  const prefix = isolatedOnly ? '' : `${codes.join(', ')}, `;
  console.error(`[test-ci:sharded] ${process.exitCode === 0 ? 'PASS' : 'FAIL'} (${prefix}isolated ${launched.join(', ')})`);
}
