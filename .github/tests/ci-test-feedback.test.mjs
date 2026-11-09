import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { loadConfigFromFile } from 'vite';
import { BaseSequencer } from 'vitest/node';
import { WeightedCalibrationSequencer } from '../../test/config/weighted-sequencer.mjs';
import { FEEDBACK_SCHEMA, decodeFeedback, encodeFeedback, feedbackId, orderFeedback,
  replayFeedback, summarizeFeedback, validateFeedback } from '../scripts/ci-test-feedback.mjs';

const role = 'Mac exhaustive (4/4)';
const event = (overrides = {}) => ({ schema: FEEDBACK_SCHEMA, source: 'a'.repeat(40), runId: '100',
  attempt: 1, jobId: '200', role, logSha256: 'b'.repeat(64), occurrence: 0,
  file: 'test/a.test.ts', result: 'passed', elapsedMs: 1000, endedAt: '2026-11-06T16:00:00.1234567Z', ...overrides });
const spec = (name, project = 'unit') => ({ file: `test/${name}.test.ts`, project, original: Symbol(name) });
const options = { role, fileOf: (value) => value.file, projectOf: (value) => value.project };

test('real Vitest configuration enables each independent sequencer opt-in', async (t) => {
  const names = ['ASHLR_TEST_CI_FAILURE_FIRST', 'ASHLR_TEST_CI_WEIGHTED_PARTITION', 'ASHLR_TEST_CI_WEIGHTED_HINTS'];
  const before = names.map((name) => process.env[name]);
  t.after(() => names.forEach((name, index) => {
    if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index];
  }));
  const configPath = fileURLToPath(new URL('../../vitest.config.ts', import.meta.url));
  let projects;
  for (const [name, failureFirst, weighted, enabled] of [
    ['neither flag', undefined, undefined, false],
    ['failure-first only', '1', undefined, true],
    ['weighted only', undefined, '1', true],
    ['both flags', '1', '1', true],
    ['non-opt-in values', 'true', '2', false],
  ]) await t.test(name, async () => {
    for (const [key, value] of [[names[0], failureFirst], [names[1], weighted], [names[2], undefined]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // Exercise Vite's real TS configuration loader, not a source-text assertion
    // or a manually constructed adapter that bypasses configuration wiring.
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, configPath, undefined, 'silent');
    assert.ok(loaded);
    const actual = loaded.config.test;
    const laneInventory = actual.projects.map((project) => ({
      name: project.test.name, include: project.test.include, exclude: project.test.exclude,
      maxWorkers: project.test.maxWorkers, sequence: project.test.sequence,
    }));
    projects ??= laneInventory;
    assert.deepEqual(laneInventory, projects, 'an ordering opt-in must not alter project collection');
    const Sequencer = actual.sequence?.sequencer;
    assert.equal(Boolean(Sequencer), enabled);
    if (enabled) assert.ok(Sequencer.prototype instanceof BaseSequencer);
  });
});

test('replay survives out-of-order delivery and identical retry without losing filtered occurrences', () => {
  const a = event(); const b = event({ occurrence: 1, result: 'failed' });
  const c = event({ attempt: 2, result: 'unknown', elapsedMs: null, endedAt: null });
  const forward = replayFeedback([a, b, c]);
  const retried = replayFeedback([c, a, b, a]);
  assert.deepEqual(retried.events, forward.events);
  assert.equal(retried.digest, forward.digest);
  assert.equal(retried.duplicates, 1);
  assert.equal(retried.events.length, 3);
  assert.notEqual(feedbackId(a), feedbackId(b));
  assert.notEqual(feedbackId(a), feedbackId(c));
  assert.deepEqual(decodeFeedback(encodeFeedback(retried.events)).events, forward.events);
});

test('same occurrence cannot silently change result, path, role, timing or provenance', () => {
  for (const change of [{ result: 'failed' }, { file: 'test/b.test.ts' }, { role: 'another role' },
    { elapsedMs: 2000 }, { logSha256: 'c'.repeat(64) }, { endedAt: null }]) {
    assert.throws(() => replayFeedback([event(), event(change)]), /conflicting/);
  }
});

test('closed metadata refuses raw payloads, malformed identities, coercion and unbounded timings', () => {
  const invalid = [{ title: 'private fixture' }, { source: ['a'.repeat(40)] }, { logSha256: ['b'.repeat(64)] },
    { runId: 100 }, { attempt: 0 }, { attempt: 1.5 }, { jobId: '0' }, { occurrence: -1 },
    { result: ['passed'] }, { result: 'success' }, { elapsedMs: '0' }, { elapsedMs: NaN },
    { elapsedMs: Infinity }, { elapsedMs: -1 }, { elapsedMs: 86_400_001 }, { role: 'role\nsecret' },
    { file: 'test/../private.test.ts' }, { file: '/home/private.test.ts' }, { file: 'test//a.test.ts' },
    { file: 'test/a.test.ts\nsecret' }, { endedAt: 'yesterday' }];
  for (const change of invalid) assert.throws(() => validateFeedback(event(change)));
  const missing = event(); delete missing.result;
  assert.throws(() => validateFeedback(missing));
});

test('journal framing preserves empty history and refuses truncation or corrupt rows', () => {
  assert.deepEqual(decodeFeedback('').events, []);
  const encoded = encodeFeedback([event()]);
  assert.throws(() => decodeFeedback(encoded.trimEnd()), /truncated/);
  assert.throws(() => decodeFeedback(encoded + '\n'), /framing/);
  assert.throws(() => decodeFeedback(encoded + '{broken}\n'));
  assert.throws(() => decodeFeedback('x'.repeat(64 * 1024 * 1024 + 1)), /byte limit/);
});

test('rollup counts actual role observations only and never converts missing or skipped to pass', () => {
  const rows = [event(), event({ occurrence: 1, result: 'failed', elapsedMs: 3000 }),
    event({ occurrence: 2, result: 'skipped', elapsedMs: null }),
    event({ occurrence: 3, result: 'unknown', elapsedMs: null }),
    event({ occurrence: 4, role: 'other role' })];
  assert.deepEqual(summarizeFeedback([...rows, rows[0]], role), [{ file: 'test/a.test.ts',
    passed: 1, failed: 1, skipped: 1, unknown: 1, timedObservations: 2, sources: ['a'.repeat(40)], medianElapsedMs: 1000 }]);
  assert.deepEqual(summarizeFeedback(rows, 'missing'), []);
});

test('fail-first ordering retains exact objects, coverage and every existing project slot', () => {
  const specs = [spec('a'), spec('b', 'real-io'), spec('c'), spec('d', 'real-io'), spec('e'), spec('f')];
  const original = [...specs];
  const rows = [event(), event({ occurrence: 1, file: specs[2].file, result: 'failed', elapsedMs: 2000 }),
    event({ occurrence: 2, file: specs[4].file, result: 'failed', elapsedMs: 1000 }),
    event({ occurrence: 3, file: specs[3].file, result: 'failed', elapsedMs: null })];
  const output = orderFeedback(specs, rows, options);
  assert.deepEqual(output.ordered, [specs[4], specs[3], specs[2], specs[1], specs[5], specs[0]]);
  assert.deepEqual(specs, original);
  assert.deepEqual(new Set(output.ordered), new Set(specs));
  assert.deepEqual(output.ordered.map(options.projectOf), specs.map(options.projectOf));
  assert.equal(output.report.collected, 6);
  assert.equal(output.report.knownFailures, 3);
  assert.equal(output.report.unobserved, 2);
  assert.equal(output.report.measuredSpeedup, null);
  assert.equal(output.report.testSelectionEnabled, false);
  assert.equal(output.report.resultReuseEnabled, false);
});

test('no feedback or another role retains caller order; skipped-only is explicitly uncertain', () => {
  const specs = [spec('b'), spec('a'), spec('c')];
  assert.deepEqual(orderFeedback(specs, [], options).ordered, specs);
  assert.deepEqual(orderFeedback(specs, [event({ role: 'other role' })], options).ordered, specs);
  assert.deepEqual(orderFeedback(specs, [event(), event({ occurrence: 1, file: specs[2].file, result: 'skipped' })], options).ordered,
    [specs[0], specs[2], specs[1]]);
});

test('lossless ordering rejects ambiguous substring filters and duplicate collection', () => {
  const a = spec('a');
  for (const specs of [[a, a], [a, { ...a }], [a, { ...a, file: 'test/xtest/a.test.ts' }]]) {
    assert.throws(() => orderFeedback(specs, [], options));
  }
  assert.throws(() => orderFeedback([a], [], { ...options, projectOf: () => null }));
});

test('4000 collected specs remain a complete deterministic permutation across project groups', () => {
  const specs = Array.from({ length: 4_000 }, (_, index) => spec(`file-${index}`, index % 3 === 0 ? 'real-io' : 'unit'));
  const rows = specs.filter((_, index) => index % 71 === 0).map((value, occurrence) => event({
    occurrence, file: value.file, result: 'failed', elapsedMs: occurrence % 7 ? occurrence : null }));
  const a = orderFeedback(specs, rows, options);
  const b = orderFeedback(specs, [...rows].reverse(), options);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.ordered).size, specs.length);
  assert.deepEqual(new Set(a.ordered), new Set(specs));
});

test('actual pinned Vitest sequencer preserves local result slots, shards and invalid-history fallback', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-feedback-')));
  const snapshot = join(root, 'feedback.json');
  const names = ['ASHLR_TEST_CI_FAILURE_FIRST', 'ASHLR_TEST_CI_FEEDBACK_SNAPSHOT', 'ASHLR_TEST_CI_FEEDBACK_ROLE', 'ASHLR_TEST_CI_WEIGHTED_PARTITION'];
  const before = names.map((name) => process.env[name]);
  const context = { config: { root, shard: { count: 4, index: 1 } }, cache: {
    getFileTestResults: (key) => key.endsWith('test/a.test.ts') ? { failed: true, duration: 9000 } : null,
    getFileStats: () => null,
  } };
  const sequencer = new WeightedCalibrationSequencer(context);
  const specs = ['a', 'b', 'c', 'd'].map((name) => ({ moduleId: join(root, `test/${name}.test.ts`),
    project: { name: 'unit', config: { sequence: { groupOrder: 1 }, isolate: true } } }));
  try {
    delete process.env.ASHLR_TEST_CI_FAILURE_FIRST;
    delete process.env.ASHLR_TEST_CI_WEIGHTED_PARTITION;
    const baseline = await sequencer.sort(specs);
    const baselineShard = await sequencer.shard(specs);
    writeFileSync(snapshot, JSON.stringify({ schema: 'phantom-ci-test-feedback-snapshot/v1',
      events: [event({ file: 'test/d.test.ts', result: 'failed' })] }));
    process.env.ASHLR_TEST_CI_FAILURE_FIRST = '1';
    process.env.ASHLR_TEST_CI_FEEDBACK_SNAPSHOT = snapshot;
    process.env.ASHLR_TEST_CI_FEEDBACK_ROLE = role;
    const ordered = await sequencer.sort(specs);
    assert.equal(ordered[baseline.indexOf(specs[0])], specs[0]);
    assert.ok(ordered.indexOf(specs[3]) < ordered.indexOf(specs[1]));
    assert.deepEqual(new Set(ordered), new Set(specs));
    assert.deepEqual(await sequencer.shard(specs), baselineShard);
    writeFileSync(snapshot, '{broken');
    assert.deepEqual(await sequencer.sort(specs), baseline);
    process.env.ASHLR_TEST_CI_FAILURE_FIRST = '0';
    assert.deepEqual(await sequencer.sort(specs), baseline);
  } finally {
    names.forEach((name, index) => { if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index]; });
    rmSync(root, { recursive: true, force: true });
  }
});
