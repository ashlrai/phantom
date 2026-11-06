// Stateless test feedback replay and lossless fail-first ordering. No result reuse.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { assertExactFilters } from '../../scripts/test-shard-plan.mjs';

export const FEEDBACK_SCHEMA = 'phantom-ci-test-feedback/v1';
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_EVENTS = 100_000;
const MAX_BYTES = 64 * 1024 * 1024;
const RESULTS = new Set(['passed', 'failed', 'skipped', 'unknown']);
const KEYS = ['schema', 'source', 'runId', 'attempt', 'jobId', 'role', 'logSha256', 'occurrence',
  'file', 'result', 'elapsedMs', 'endedAt'];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const modulePath = (value) => typeof value === 'string' && value.length <= 512 &&
  /^(?:test|src\/web-ui)\/[A-Za-z0-9_./@+-]+\.test\.[cm]?[jt]sx?$/.test(value) &&
  value.split('/').every((part) => part !== '.' && part !== '..' && part !== '');

/** Closed metadata projection: titles, errors, fixtures and log text are rejected. */
export function validateFeedback(row) {
  assert.ok(plain(row), 'feedback must be an object');
  assert.deepEqual(Object.keys(row).sort(), [...KEYS].sort(), 'unexpected feedback fields');
  assert.equal(row.schema, FEEDBACK_SCHEMA, 'unsupported feedback schema');
  assert.ok(typeof row.source === 'string' && SHA.test(row.source), 'invalid source');
  assert.ok(identifier(row.runId) && identifier(row.jobId), 'invalid run/job identity');
  assert.ok(Number.isSafeInteger(row.attempt) && row.attempt > 0, 'invalid attempt');
  assert.ok(Number.isSafeInteger(row.occurrence) && row.occurrence >= 0, 'invalid occurrence');
  assert.ok(typeof row.role === 'string' && /^[A-Za-z0-9 ()/.,_+-]{1,128}$/.test(row.role), 'invalid role');
  assert.ok(typeof row.logSha256 === 'string' && HASH.test(row.logSha256), 'invalid log digest');
  assert.ok(modulePath(row.file), 'invalid module path');
  assert.ok(RESULTS.has(row.result), 'invalid result');
  assert.ok(row.elapsedMs === null || (typeof row.elapsedMs === 'number' &&
    Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= 86_400_000), 'invalid timing');
  assert.ok(row.endedAt === null || (typeof row.endedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(row.endedAt) &&
    Number.isFinite(Date.parse(row.endedAt))), 'invalid observation time');
  return Object.fromEntries(KEYS.map((key) => [key, row[key]]));
}

// An occurrence is local to one source/run/attempt/job, including filtered reruns.
// Log digest is provenance, not identity: two versions of that occurrence conflict.
export function feedbackId(input) {
  const row = validateFeedback(input);
  return hash([row.source, row.runId, row.attempt, row.jobId, row.occurrence]);
}

/** Whole replay is deterministic. Identical deliveries deduplicate; conflicts fail. */
export function replayFeedback(rows) {
  assert.ok(Array.isArray(rows) && rows.length <= MAX_EVENTS, 'feedback event limit exceeded');
  const events = new Map();
  let duplicates = 0;
  for (const input of rows) {
    const row = validateFeedback(input);
    const id = feedbackId(row);
    const previous = events.get(id);
    if (previous) {
      assert.deepEqual(previous, row, 'conflicting feedback occurrence');
      duplicates++;
    } else events.set(id, row);
  }
  const sorted = [...events].sort(([a], [b]) => a.localeCompare(b));
  return { events: sorted.map(([, row]) => row), duplicates, digest: hash(sorted) };
}

export function encodeFeedback(rows) {
  const replay = replayFeedback(rows);
  const text = replay.events.map((row) => JSON.stringify(row)).join('\n') + (replay.events.length ? '\n' : '');
  assert.ok(Buffer.byteLength(text) <= MAX_BYTES, 'feedback byte limit exceeded');
  return text;
}

/** A truncated final row is explicit corruption, never silently accepted as complete. */
export function decodeFeedback(text) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= MAX_BYTES, 'feedback byte limit exceeded');
  assert.ok(text === '' || text.endsWith('\n'), 'truncated feedback journal');
  const lines = text === '' ? [] : text.slice(0, -1).split('\n');
  assert.ok(lines.length <= MAX_EVENTS && lines.every((line) => line !== ''), 'invalid feedback framing');
  return replayFeedback(lines.map((line) => JSON.parse(line)));
}

/** Aggregate actual observations only; absent/skipped/unknown results are not passes. */
export function summarizeFeedback(rows, role) {
  assert.ok(typeof role === 'string', 'explicit role required');
  const replay = replayFeedback(rows);
  const modules = new Map();
  for (const row of replay.events) {
    if (row.role !== role) continue;
    const state = modules.get(row.file) ?? { file: row.file, passed: 0, failed: 0, skipped: 0, unknown: 0,
      timedObservations: 0, elapsedMs: [], sources: new Set() };
    state[row.result]++;
    if (row.elapsedMs !== null) { state.timedObservations++; state.elapsedMs.push(row.elapsedMs); }
    state.sources.add(row.source);
    modules.set(row.file, state);
  }
  return [...modules.values()].sort((a, b) => a.file.localeCompare(b.file)).map((row) => {
    const costs = row.elapsedMs.sort((a, b) => a - b);
    return { file: row.file, passed: row.passed, failed: row.failed, skipped: row.skipped,
      unknown: row.unknown, timedObservations: row.timedObservations, sources: [...row.sources].sort(),
      medianElapsedMs: costs.length ? costs[Math.floor((costs.length - 1) / 2)] : null };
  });
}

/** Reorder caller-owned collected objects only, within their existing project slots.
 * Historical failure is an advisory priority, not proof the current test will fail.
 * This never partitions, omits, synthesizes, passes or quarantines a test.
 */
export function orderFeedback(specs, rows, { role, fileOf, projectOf }) {
  assert.ok(Array.isArray(specs), 'collected specs required');
  assert.equal(new Set(specs).size, specs.length, 'duplicate collected object');
  const files = specs.map(fileOf);
  assert.ok(files.every(modulePath), 'invalid collected path');
  assert.equal(new Set(files).size, files.length, 'duplicate collected module');
  assertExactFilters(files, files);
  const facts = new Map(summarizeFeedback(rows, role).map((row) => [row.file, row]));
  const projects = new Map();
  const projectNames = specs.map((spec) => {
    const project = projectOf(spec);
    assert.ok(typeof project === 'string' && project.length > 0, 'missing collected project');
    const group = projects.get(project) ?? [];
    group.push(spec); projects.set(project, group);
    return project;
  });
  const rank = (spec) => {
    const fact = facts.get(fileOf(spec));
    return fact?.failed ? 0 : !fact || (!fact.passed && !fact.failed) ? 1 : 2;
  };
  const cost = (spec) => facts.get(fileOf(spec))?.medianElapsedMs ?? Infinity;
  for (const group of projects.values()) group.sort((a, b) => rank(a) - rank(b) ||
    // Fast likely failures first; unmeasured failures follow measured failures.
    (rank(a) === 0 ? (cost(a) < cost(b) ? -1 : cost(a) > cost(b) ? 1 : 0) : 0));
  const cursors = new Map();
  const ordered = projectNames.map((project) => {
    const index = cursors.get(project) ?? 0; cursors.set(project, index + 1);
    return projects.get(project)[index];
  });
  assert.equal(ordered.length, specs.length, 'ordering lost coverage');
  assert.equal(new Set(ordered).size, specs.length, 'ordering duplicated coverage');
  const input = new Set(specs);
  assert.ok(ordered.every((spec) => input.has(spec)), 'ordering replaced collected objects');
  assert.deepEqual(ordered.map(projectOf), projectNames, 'ordering moved project slots');
  return { ordered, report: { schema: 'phantom-ci-test-feedback-order/v1', role,
    collected: specs.length, knownFailures: files.filter((file) => facts.get(file)?.failed).length,
    unobserved: files.filter((file) => !facts.has(file)).length,
    historicalOnly: true, testSelectionEnabled: false, resultReuseEnabled: false, measuredSpeedup: null } };
}
