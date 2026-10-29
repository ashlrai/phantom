/* global process, console */
// Daily Mac rotation (RQ-DAILY-15-PHANTOM-2, Masbot for Mason, Oct 28 2026).
// The scheduled daily run takes one of seven slices of the Mac exhaustive work
// so its wall clock stays near 15 minutes; every slice runs once in any seven
// consecutive days. Dispatch with mac_shard=all (the default), every reusable
// workflow_call run, and any commit carrying a release tag run the complete,
// unchanged Mac lanes, which are the only runs release attestation accepts.
import { appendFileSync, realpathSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SLICES = 7;
const RELEASE_TAG = /^(?:v|desktop-v)\d/;
// Measured macOS seconds per isolated case, copied from test-ci-sharded.mjs;
// a case missing here (a newly isolated suite) is weighed at 120s.
const ISOLATED_SECONDS = {
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

/** Rotated slice for this run, or null for the complete Mac set. */
export function selectSlice({ eventName, input, now, releaseTags }) {
  if (releaseTags.some((tag) => RELEASE_TAG.test(tag))) return null;
  if (eventName === 'schedule') return Math.floor(now.getTime() / 86_400_000) % SLICES;
  if (eventName === 'workflow_dispatch' && /^[0-6]$/.test(input ?? '')) return Number(input);
  if (eventName === 'workflow_dispatch' && input !== undefined && input !== '' && input !== 'all') throw new Error('mac_shard must be all or 0..6');
  return null;
}

/** The isolated cases exactly as test-ci-sharded.mjs runs them. */
export async function isolatedCases(root) {
  // Loaded lazily: the plan step runs before npm ci.
  const { isolatedScope } = await import('../../scripts/hosted-build-artifact.mjs');
  const { suites, marker } = isolatedScope(root);
  return [...suites.map((file) => ({ file, label: file })),
    { file: marker, filter: 'automatic seed measurement: false', label: 'campaign false' },
    { file: marker, filter: 'automatic seed measurement: true', label: 'campaign true' }];
}

/** Longest-first greedy split of the isolated cases into seven slices. */
export function isolatedSlices(cases) {
  const weight = (c) => ISOLATED_SECONDS[c.label] ?? 120;
  const bins = Array.from({ length: SLICES }, () => ({ seconds: 0, cases: [] }));
  const order = cases.map((c, i) => ({ c, i })).sort((a, b) => weight(b.c) - weight(a.c) || a.i - b.i);
  for (const { c } of order) {
    const bin = bins.reduce((best, b) => (b.seconds < best.seconds ? b : best));
    bin.cases.push(c); bin.seconds += weight(c);
  }
  return bins;
}

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function plan(root, env) {
  const tags = git(root, ['tag', '--points-at', 'HEAD']).split('\n').filter(Boolean);
  const slice = selectSlice({ eventName: env.EVENT_NAME, input: env.MAC_SHARD_INPUT, now: new Date(), releaseTags: tags });
  const rotated = slice !== null;
  const out = {
    mac_slice: rotated ? String(slice) : '',
    // Rotated runs keep only general leg 1 (it runs the general slice).
    mac_general_exclude: JSON.stringify(rotated ? [{ shard: 2 }, { shard: 3 }, { shard: 4 }] : []),
  };
  const summary = rotated
    ? `Mac rotation: slice ${slice} of 0..6 (general vitest shard ${slice + 1}/${SLICES} plus isolated slice ${slice}).`
    : 'Mac rotation: complete Mac set (all four general partitions and all isolated suites).';
  return { out, summary };
}

function run(file, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: process.cwd(), env, stdio: 'inherit' });
    child.once('error', () => resolve(1));
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

async function runSlice(root, kind, sliceInput) {
  if (!/^[0-6]$/.test(sliceInput ?? '')) throw new Error('Missing rotation slice');
  const slice = Number(sliceInput);
  const runner = 'scripts/test-ci.mjs';
  const cases = await isolatedCases(root);
  const env = { ...process.env,
    ASHLR_ENGINEERING_SETUP_PHASE_TIMING: process.env.ASHLR_ENGINEERING_SETUP_PHASE_TIMING ?? '1',
    ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING: process.env.ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING ?? '1',
    ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING: process.env.ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING ?? '1',
    ASHLR_ACCEPTANCE_PHASE_TIMING: process.env.ASHLR_ACCEPTANCE_PHASE_TIMING ?? '1' };
  delete env.ASHLR_TEST_CI_WEIGHTED_PARTITION; delete env.ASHLR_TEST_CI_WEIGHTED_HINTS;
  if (kind === 'general') {
    // Same flags test-ci-sharded.mjs gives a selected general shard.
    const exclusions = [...new Set(cases.map((c) => c.file))].map((file) => `--exclude=${file}`);
    console.error(`[mac-rotation] general vitest shard ${slice + 1}/${SLICES}`);
    return run(runner, [`--shard=${slice + 1}/${SLICES}`, '--maxWorkers=2', '--bail=1', ...exclusions],
      { ...env, ASHLR_VITEST_UNIT_MAX_WORKERS: '1' });
  }
  if (kind !== 'isolated') throw new Error('Usage: run general|isolated');
  const bin = isolatedSlices(cases)[slice];
  for (const c of bin.cases) {
    console.error(`[mac-rotation] isolated ${c.label}`);
    const code = await run(runner, [c.file, ...(c.filter ? ['-t', c.filter] : []), '--maxWorkers=1', '--fileParallelism=false', '--bail=1'], env);
    if (code !== 0) return code;
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = realpathSync(process.cwd());
  const [verb, kind] = process.argv.slice(2);
  try {
    if (verb === 'plan') {
      const { out, summary } = plan(root, process.env);
      if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GitHub step output');
      appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(''));
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
      console.log(summary);
    } else if (verb === 'run') {
      process.exitCode = await runSlice(root, kind, process.env.MAC_SLICE);
    } else throw new Error('Usage: ci-mac-rotation.mjs plan | run general|isolated');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
