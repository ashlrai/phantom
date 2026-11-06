#!/usr/bin/env node
// Offline diagnostics only. No network, subprocesses, label mutations or test selection.
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const key = (parts) => JSON.stringify(parts);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const LIMITS = { manifestBytes: 2 * 1024 * 1024, reportBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024, runs: 1000, reports: 5000, cases: 500_000 };
const STATES = new Set(['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled']);
const CONCLUSIONS = new Set(['success', 'failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required', 'startup_failure']);

export const HELP = `Usage: node scripts/flake-ledger.mjs HISTORY.json > ledger.json

Read local Vitest JSON reports from CI history. No GitHub access is performed.
HISTORY.json (report paths are relative to its directory):
{
  "schema": "phantom-flake-history/v1",
  "repository": "ashlrai/phantom",
  "runs": [{
    "id": "123456", "attempt": 1, "headSha": "<40 lowercase hex characters>",
    "workflow": "CI", "job": "Tests (ubuntu)", "project": "unit",
    "completedAt": "2026-10-26T12:00:00.000Z", "conclusion": "failure",
    "sourceRoot": "/home/runner/work/phantom/phantom",
    "reports": ["run-123456/attempt-1/unit.json"]
  }]
}

Supply failed AND successful reports, including rerun attempts. Use reports: []
for unavailable/expired/cancelled captures; absent tests are never inferred as
passes. sourceRoot is the original CI checkout (POSIX or Windows), not local cwd.
job/project must distinguish platforms and test configurations. Generate raw
reports with Vitest's --reporter=json --outputFile.json=PATH alongside the normal
reporter; preserve the test command's exit status. No CI configuration is changed.

Output: phantom-flake-ledger/v1 with per-test counts, observations, report hashes,
same-revision fail/pass or retry evidence, and ci:quarantine-candidate suggestions.
Duplicate full titles are ambiguous and never suggested. Cross-commit mixed
outcomes alone are inconclusive. Exact reimports are idempotent; conflicting
copies fail. Input metadata is caller-supplied, NOT authenticated CI evidence.
Only supplied history is measured; no full-history or required-check coverage is
claimed. Suggestions are data only, never permission to skip a required check.
Exit 0 means analysis completed (including failed tests); exit 1 means invalid
or unavailable input. Neither exit code is a test result or merge authorization.
Limits: 1000 run/job records, 5000 reports, 500000 cases, 64 MiB/report, 256 MiB total.
`;

class InputError extends Error {}
function need(condition, message) { if (!condition) throw new InputError(message); }
function text(value, max = 1024) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    ![...value].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}
function repoPath(value) {
  need(text(value) && !value.includes('\\') && !posix.isAbsolute(value) && !win32.isAbsolute(value) &&
    !value.includes(':') && value.split('/').every((part) => part && part !== '.' && part !== '..'), 'Invalid relative report path');
  return value;
}
function testPath(name, root) {
  need(text(name, 4096) && text(root, 4096), 'Invalid CI checkout path');
  const paths = win32.isAbsolute(root) && !posix.isAbsolute(root) ? win32 : posix;
  need(paths.isAbsolute(root) && paths.isAbsolute(name), 'Absolute CI checkout paths required');
  const file = paths.relative(root, name).replaceAll('\\', '/');
  repoPath(file);
  need(/\.test\.[cm]?[jt]sx?$/u.test(file), 'Expected a test module');
  return file;
}
function json(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new InputError('Invalid JSON report'); }
}

function normalize(raw, sourceRoot) {
  need(raw && typeof raw.success === 'boolean' && Array.isArray(raw.testResults), 'Invalid Vitest report');
  const totals = { passed: 0, failed: 0, skipped: 0, todo: 0 };
  const cases = [], modules = new Set(); let moduleFailures = 0;
  for (const module of raw.testResults) {
    need(module && ['passed', 'failed'].includes(module.status) && Array.isArray(module.assertionResults), 'Invalid Vitest module');
    const file = testPath(module.name, sourceRoot);
    need(!modules.has(file), 'Duplicate test module'); modules.add(file);
    if (module.status === 'failed') moduleFailures++;
    const occurrences = new Map(); const start = cases.length;
    for (const item of module.assertionResults) {
      // Titles are JSON data and may legitimately contain newlines or NULs;
      // unlike paths/metadata, their characters must not be rewritten/rejected.
      need(item && typeof item.fullName === 'string' && item.fullName.length > 0 && item.fullName.length <= 8192 && STATES.has(item.status) &&
        Array.isArray(item.failureMessages) && item.failureMessages.every((message) => typeof message === 'string'), 'Invalid Vitest case');
      const occurrence = occurrences.get(item.fullName) ?? 0;
      occurrences.set(item.fullName, occurrence + 1);
      const state = ['pending', 'disabled'].includes(item.status) ? 'skipped' : item.status;
      totals[state]++;
      // Same identity convention as CI qualification. Retain duplicates but do
      // not infer cross-run instability from their potentially shifting order.
      cases.push({ id: hash(`${file}\0${item.fullName}\0${occurrence}`), file, name: item.fullName,
        occurrence, state, reportedState: item.status,
        retriedPass: state === 'passed' && item.failureMessages.length > 0 });
    }
    for (let index = start; index < cases.length; index++) cases[index].ambiguous = occurrences.get(cases[index].name) > 1;
    need(module.status === 'failed' || !module.assertionResults.some((item) => item.status === 'failed'), 'Module result disagrees with cases');
  }
  const expected = { numTotalTests: cases.length, numPassedTests: totals.passed, numFailedTests: totals.failed,
    numPendingTests: totals.skipped, numTodoTests: totals.todo };
  for (const [field, value] of Object.entries(expected)) need(raw[field] === value, 'Vitest case totals disagree');
  need(Number.isSafeInteger(raw.numFailedTestSuites) && raw.numFailedTestSuites >= moduleFailures &&
    (raw.success === false || (totals.failed === 0 && raw.numFailedTestSuites === 0 && moduleFailures === 0)), 'Vitest summary disagrees');
  return { cases, moduleFailures };
}

/** Pure aggregation boundary: readReport returns raw bytes, never executable code. */
export function buildFlakeLedger(history, readReport) {
  need(history?.schema === 'phantom-flake-history/v1' && text(history.repository) &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(history.repository) && Array.isArray(history.runs) &&
    history.runs.length <= LIMITS.runs, 'Invalid CI history manifest');
  const runs = new Map(), tests = new Map(), cache = new Map();
  let totalBytes = 0, caseCount = 0, reportCount = 0;
  for (const run of history.runs) {
    need(run && typeof run.id === 'string' && /^[1-9][0-9]{0,19}$/u.test(run.id) &&
      Number.isSafeInteger(run.attempt) && run.attempt > 0 && /^[a-f0-9]{40}$/u.test(run.headSha ?? '') &&
      text(run.workflow) && text(run.job) && text(run.project) && text(run.sourceRoot, 4096) &&
      (posix.isAbsolute(run.sourceRoot) || win32.isAbsolute(run.sourceRoot)) &&
      text(run.completedAt) && Number.isFinite(Date.parse(run.completedAt)) &&
      new Date(run.completedAt).toISOString() === run.completedAt && CONCLUSIONS.has(run.conclusion) &&
      Array.isArray(run.reports), 'Invalid CI run metadata');
    need(run.reports.length <= LIMITS.reports, 'Too many reports');
    const runKey = key([run.workflow, run.job, run.project, run.id, run.attempt]);
    const reports = [], rows = [], files = new Set(), paths = new Set(); let moduleFailures = 0;
    for (const path of run.reports) {
      repoPath(path); need(!paths.has(path), 'Duplicate report path'); paths.add(path);
      need(++reportCount <= LIMITS.reports, 'Too many reports');
      if (!cache.has(path)) {
        const bytes = readReport(path);
        need(bytes instanceof Uint8Array && bytes.byteLength <= LIMITS.reportBytes, 'Report is too large or unavailable');
        totalBytes += bytes.byteLength; need(totalBytes <= LIMITS.totalBytes, 'History exceeds byte limit');
        cache.set(path, { sha256: hash(bytes), raw: json(bytes) });
      }
      const { sha256, raw } = cache.get(path);
      const normalized = normalize(raw, run.sourceRoot);
      caseCount += normalized.cases.length; need(caseCount <= LIMITS.cases, 'History exceeds case limit');
      for (const module of raw.testResults) {
        const file = testPath(module.name, run.sourceRoot);
        need(!files.has(file), 'Overlapping test modules within one run/job'); files.add(file);
      }
      moduleFailures += normalized.moduleFailures;
      reports.push({ path, sha256, success: raw.success, cases: normalized.cases.length });
      rows.push(...normalized.cases.map((item) => ({ ...item, reportSha256: sha256 })));
    }
    reports.sort((a, b) => compare(a.path, b.path));
    const metadata = { id: run.id, attempt: run.attempt, headSha: run.headSha, workflow: run.workflow,
      job: run.job, project: run.project, sourceRoot: run.sourceRoot, completedAt: run.completedAt, conclusion: run.conclusion,
      reports, moduleFailures, coverage: reports.length ? 'supplied-reports-only' : 'unobserved' };
    if (runs.has(runKey)) {
      need(key(runs.get(runKey)) === key(metadata), 'Conflicting reimport of CI run/job');
      continue;
    }
    runs.set(runKey, metadata);
    for (const row of rows) {
      const id = hash(key([run.workflow, run.job, run.project, row.id]));
      if (!tests.has(id)) tests.set(id, { id, caseId: row.id, file: row.file, name: row.name,
        occurrence: row.occurrence, workflow: run.workflow, job: run.job, project: run.project,
        ambiguous: false, observations: [] });
      const test = tests.get(id); test.ambiguous ||= row.ambiguous;
      test.observations.push({ runId: run.id, attempt: run.attempt, headSha: run.headSha,
        completedAt: run.completedAt, state: row.state, reportedState: row.reportedState,
        retriedPass: row.retriedPass, reportSha256: row.reportSha256 });
    }
  }
  const orderedRuns = [...runs.values()].sort((a, b) => compare(key(a), key(b)));
  const entries = [...tests.values()].sort((a, b) => compare(a.id, b.id)).map((test) => {
    test.observations.sort((a, b) => compare(a.completedAt, b.completedAt) || compare(a.runId, b.runId) || a.attempt - b.attempt);
    const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, retriedPasses: 0 };
    const revisions = new Map();
    for (const item of test.observations) {
      counts[item.state]++; if (item.retriedPass) counts.retriedPasses++;
      if (!revisions.has(item.headSha)) revisions.set(item.headSha, new Set());
      revisions.get(item.headSha).add(item.state);
    }
    const mixedRevisions = [...revisions].filter(([, states]) => states.has('passed') && states.has('failed')).map(([sha]) => sha).sort();
    const evidence = [];
    if (mixedRevisions.length) evidence.push({ kind: 'same-revision-fail-pass', revisions: mixedRevisions });
    if (counts.retriedPasses) evidence.push({ kind: 'passed-with-retry-errors', count: counts.retriedPasses });
    const executions = counts.passed + counts.failed;
    const classification = test.ambiguous ? 'ambiguous' : evidence.length ? 'flaky' :
      counts.passed && counts.failed ? 'mixed-unconfirmed' : counts.failed ? 'consistent-fail' :
        counts.passed ? 'consistent-pass' : 'unexecuted';
    return { ...test, counts, executions, finalFailureRate: executions ? counts.failed / executions : null, classification, evidence };
  });
  return { schema: 'phantom-flake-ledger/v1', repository: history.repository,
    advisoryOnly: true, requiredChecks: 'unchanged', provenance: 'caller-supplied-not-authenticated',
    coverage: 'supplied-reports-only',
    summary: { runJobs: orderedRuns.length, missingReportRunJobs: orderedRuns.filter((run) => !run.reports.length).length,
      tests: entries.length, flakyTests: entries.filter((test) => test.classification === 'flaky').length,
      ambiguousTests: entries.filter((test) => test.ambiguous).length },
    runs: orderedRuns, tests: entries,
    suggestions: entries.filter((test) => test.classification === 'flaky').map((test) => ({
      testId: test.id, label: 'ci:quarantine-candidate', applied: false, evidence: test.evidence,
    })),
  };
}

// The CLI reads bounded regular files under the manifest directory and refuses
// observed symlinks/FIFOs. Use a stable local capture directory: parent lstat
// checks do not provide a sandbox against concurrent directory replacement.
function readBounded(path, maximum) {
  const before = lstatSync(path);
  need(before.isFile() && !before.isSymbolicLink() && before.size <= maximum, 'Expected a bounded regular file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    need(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size <= maximum, 'Input changed while opening');
    const buffer = Buffer.alloc(opened.size + 1); let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    const after = fstatSync(fd);
    need(length === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs, 'Input changed while reading');
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

export function main(args, output = console) {
  try {
    if (args.length === 1 && args[0] === '--help') { output.log(HELP); return 0; }
    need(args.length === 1 && !args[0].startsWith('-'), 'Expected one history manifest; use --help');
    const manifest = resolve(args[0]); const root = realpathSync(dirname(manifest));
    const history = json(readBounded(manifest, LIMITS.manifestBytes));
    const ledger = buildFlakeLedger(history, (path) => {
      let current = root;
      for (const part of path.split('/')) {
        current = join(current, part);
        need(!lstatSync(current).isSymbolicLink(), 'Report symlinks are refused');
      }
      return readBounded(current, LIMITS.reportBytes);
    });
    output.log(JSON.stringify(ledger, null, 2)); return 0;
  } catch (error) {
    // Native I/O/JSON errors can contain raw report text or sensitive paths.
    output.error(`Flake ledger unavailable: ${error instanceof InputError ? error.message : 'input could not be read'}. Required checks remain unchanged.`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
