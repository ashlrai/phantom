// RELEASE-CONTINUOUS-1: Auto-tag release gate. One gate: the exact candidate
// SHA must carry the fast gate (Merge Gate, secret floors, generated files,
// authority drift, Quick typecheck, Fast gate) plus the release job's own tag
// CI (Desktop release smoke, Release suites). The scheduled six-hour full
// suite is a signal that files P0 fix-forward lines; it never blocks a tag.
// RELEASE_GATE_MODE is retired: 'split' and 'full' both mean this gate, so a
// stale repository variable can neither restore the full-suite block nor fail
// Auto-tag. Any other value still refuses.
// Read-only: the job token reads check runs for one exact SHA. No new
// permissions, secrets or triggers. Fail closed on anything unexpected.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { requireProducerEnvironment } from './github-repository-binding.mjs';

export const ACTIONS_APP_ID = 15368;
// Accepted for compatibility with an existing repository variable. Both name the one fast gate.
export const MODES = Object.freeze(['split', 'full']);
// Exact check-run names (unchanged job names in ci.yml). 'all' = every latest
// run with the name must be success. 'any' = at least one success and every
// other run success or skipped (the job is designed to skip on the other event
// that reports on the same SHA: Fast gate runs on merge_group, skips on push;
// Desktop release smoke runs on the half-hour release prep, skips on push).
export const RELEASE_GATE = Object.freeze([
  ['Merge Gate', 'all'],
  ['Secret-shape scan', 'all'],
  ['Secret scan (diff)', 'all'],
  // RELEASE-GATE-SPLIT-3: push/PR-scoped jobs; a dispatched release prep on
  // the same master SHA reports them skipped, so they need one success.
  ['Check generated files', 'any'],
  ['Check authority drift (hermetic)', 'any'],
  ['Quick typecheck', 'any'],
  ['Fast gate (typecheck + affected tests)', 'any'],
  ['Desktop release smoke', 'any'],
  ['Release suites (build + signing path)', 'any'],
]);
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

export function githubCheckRuns(repo, candidate) {
  assert.ok(repo === 'ashlrai/phantom' && sha(candidate), 'unreviewed check-run read');
  try {
    const pages = execFileSync('gh', ['api', '--hostname', 'github.com', '--paginate', '--slurp',
      `repos/${repo}/commits/${candidate}/check-runs?filter=latest&app_id=${ACTIONS_APP_ID}&per_page=100`], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(pages).flatMap(page => page.check_runs ?? []);
  } catch { throw new Error('check runs unavailable; refusing unverified release gate'); }
}

// Returns { green, pending: [...], bad: [...] }. bad = a gate check concluded
// anything but success/skipped, or 'all' rule saw skipped. pending = missing,
// queued, in progress, or 'any' rule with no success yet.
export function evaluateReleaseGate(runs) {
  assert.ok(Array.isArray(runs), 'missing check-run inventory');
  const pending = []; const bad = [];
  for (const [name, rule] of RELEASE_GATE) {
    const rows = runs.filter(run => run?.name === name && run?.app?.id === ACTIONS_APP_ID);
    if (!rows.length) { pending.push(`${name} (missing)`); continue; }
    if (rows.some(run => run.status !== 'completed')) { pending.push(`${name} (running)`); continue; }
    const conclusions = rows.map(run => run.conclusion ?? 'none');
    const unexpected = conclusions.filter(c => c !== 'success' && c !== 'skipped');
    if (unexpected.length) { bad.push(`${name} (${unexpected.join(',')})`); continue; }
    if (rule === 'all' && conclusions.includes('skipped')) { bad.push(`${name} (skipped)`); continue; }
    if (rule === 'any' && !conclusions.includes('success')) { pending.push(`${name} (not run on this SHA yet)`); continue; }
  }
  return { green: pending.length === 0 && bad.length === 0, pending, bad };
}

/** Returns 'fast' for unset, 'split' and the retired 'full'. Unknown values refuse. */
export function gateMode(raw) {
  const mode = (raw ?? '').trim();
  assert.ok(mode === '' || MODES.includes(mode), `unknown RELEASE_GATE_MODE '${mode}'`);
  return 'fast';
}

export async function requireReleaseGate({ repo, candidate, mode, readRuns = githubCheckRuns }) {
  assert.ok(sha(candidate), 'candidate must be an exact SHA');
  gateMode(mode);
  const result = evaluateReleaseGate(readRuns(repo, candidate));
  if (result.bad.length) throw new Error(`release gate red: ${result.bad.join('; ')}`);
  return { mode: 'fast', ...result };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    requireProducerEnvironment(process.env);
    if (process.argv[2] !== 'require') throw new Error('Usage: ci-release-gate.mjs require');
    const result = await requireReleaseGate({ repo: process.env.GITHUB_REPOSITORY, candidate: process.env.SHA, mode: process.env.RELEASE_GATE_MODE });
    if (result.green) {
      appendFileSync(process.env.GITHUB_OUTPUT, 'green=true\n');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `release-gate=fast green sha=${process.env.SHA}\n`);
    } else {
      // Tag CI not reported yet on this SHA (for example a push before the
      // release prep run finishes). Hold quietly; the release-prep CI
      // workflow_run re-evaluates this exact SHA.
      process.stderr.write(`::notice::release gate pending: ${result.pending.join('; ')}\n`);
      appendFileSync(process.env.GITHUB_OUTPUT, 'green=false\n');
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
