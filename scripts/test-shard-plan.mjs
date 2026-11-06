#!/usr/bin/env node
/** Duration-balanced partitioning for the local backend runner.
 *
 * Measured durations only decide which shard runs a file. Membership always
 * comes from the live `vitest list` inventory, so a stale, missing or invalid
 * durations file can make shards uneven but can never drop or repeat a file.
 *
 * CLI: `node scripts/test-shard-plan.mjs --from-reports <dir>` rewrites the
 * checked-in durations from the Vitest JSON reports of a passing run.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

export const DURATIONS_SCHEMA = 'phantom-test-durations/v1';
export const durationsPath = fileURLToPath(new URL('../test/helpers/test-durations.json', import.meta.url));
// Used for every file when no measurement exists at all (fresh checkout of a
// file set the durations never saw). Any positive constant gives count balance.
const FALLBACK_MS = 1_000;
const MAX_MS = 24 * 60 * 60_000;
const testPath = /^test\/[A-Za-z0-9_./@+-]+\.test\.ts$/;

const toRelative = (root, file) => (isAbsolute(file) ? relative(root, file) : file).replaceAll('\\', '/');

/** Validate a durations document; returns Map<file, ms>. Throws on any defect. */
export function parseDurations(text) {
  const doc = JSON.parse(text);
  assert.equal(doc?.schema, DURATIONS_SCHEMA, 'unsupported durations schema');
  assert.ok(doc.files && typeof doc.files === 'object' && !Array.isArray(doc.files), 'durations files must be an object');
  const durations = new Map();
  for (const [file, ms] of Object.entries(doc.files)) {
    assert.ok(testPath.test(file) && !file.split('/').includes('..'), `invalid durations path ${JSON.stringify(file)}`);
    assert.ok(Number.isSafeInteger(ms) && ms >= 0 && ms <= MAX_MS, `invalid duration for ${file}`);
    durations.set(file, ms);
  }
  return durations;
}

/** Read the checked-in durations. A missing or invalid file only costs balance. */
export function readDurations(path = durationsPath, warn = (message) => console.error(message)) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return new Map(); }
  try { return parseDurations(text); } catch (error) {
    warn(`[test-ci:sharded] ignoring durations (${error instanceof Error ? error.message : String(error)}); shards balance by file count`);
    return new Map();
  }
}

export function serializeDurations(durations) {
  const files = Object.fromEntries([...durations].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ schema: DURATIONS_SCHEMA, files }, null, 2)}\n`;
}

/** Sum per-file elapsed milliseconds across Vitest JSON reports. */
export function durationsFromReports(reports, root) {
  const durations = new Map();
  for (const report of reports) {
    assert.ok(Array.isArray(report?.testResults), 'report has no testResults');
    for (const module of report.testResults) {
      const file = toRelative(root, String(module.name));
      const elapsed = Number(module.endTime) - Number(module.startTime);
      if (!testPath.test(file) || !Number.isFinite(elapsed) || elapsed < 0) continue;
      durations.set(file, Math.min(MAX_MS, (durations.get(file) ?? 0) + Math.round(elapsed)));
    }
  }
  return durations;
}

/** Observed files replace older entries; entries for deleted tests are dropped. */
export function mergeDurations(previous, observed, exists) {
  const merged = new Map();
  for (const [file, ms] of [...previous, ...observed]) if (exists(file)) merged.set(file, ms);
  return merged;
}

/**
 * Longest-processing-time-first assignment of `files` into `count` shards.
 * Unmeasured files are estimated at the median measured duration. Ties break
 * on path and shard index, so the same inputs always produce the same plan.
 */
export function planShards(files, durations, count) {
  assert.ok(Number.isSafeInteger(count) && count >= 1, 'shard count must be a positive integer');
  assert.equal(new Set(files).size, files.length, 'duplicate file in shard inventory');
  const known = files.map((file) => durations.get(file)).filter((ms) => ms !== undefined).sort((a, b) => a - b);
  const estimate = known.length ? Math.max(1, known[Math.floor((known.length - 1) / 2)]) : FALLBACK_MS;
  const weighted = files.map((file) => ({ file, ms: durations.get(file) ?? estimate, measured: durations.has(file) }))
    .sort((a, b) => b.ms - a.ms || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ files: [], estimatedMs: 0 }));
  for (const row of weighted) {
    let target = shards[0];
    for (const shard of shards) if (shard.estimatedMs < target.estimatedMs) target = shard;
    target.files.push(row.file);
    target.estimatedMs += row.ms;
  }
  for (const shard of shards) shard.files.sort();
  const union = shards.flatMap((shard) => shard.files);
  assert.equal(union.length, files.length, 'partition lost or repeated a file');
  assert.deepEqual(new Set(union), new Set(files), 'partition changed the file set');
  return { shards, unmeasured: weighted.filter((row) => !row.measured).map((row) => row.file), estimateMs: estimate };
}

/**
 * Vitest treats each positional filter as a case-insensitive substring of the
 * root-relative path. Prove each planned filter selects exactly its own file
 * among everything Vitest collects, so a filter can never pull in a sibling
 * (for example `test/a.test.ts` inside `test/xtest/a.test.ts`).
 */
export function assertExactFilters(selected, collected) {
  const lowered = collected.map((file) => file.toLocaleLowerCase());
  for (const file of selected) {
    const needle = file.toLocaleLowerCase();
    const matches = lowered.filter((candidate) => candidate.includes(needle));
    assert.ok(matches.length === 1 && matches[0] === needle, `filter ${file} would select ${matches.length} collected files`);
  }
}

/** Parse the `vitest list --filesOnly --json` document into sorted root-relative paths. */
export function parseInventory(listing, root) {
  assert.ok(Array.isArray(listing) && listing.length > 0, 'vitest list returned no test files');
  const files = listing.map((row) => {
    assert.ok(typeof row?.file === 'string', 'vitest list row without a file');
    const file = toRelative(root, row.file);
    assert.ok(testPath.test(file), `unexpected collected path ${JSON.stringify(file)}`);
    return file;
  });
  assert.equal(new Set(files).size, files.length, 'vitest list reported a file twice');
  return files.sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--from-reports') {
    console.error('Usage: test-shard-plan.mjs --from-reports <directory of Vitest JSON reports>');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const reports = readdirSync(args[1]).filter((name) => name.endsWith('.json')).sort()
    .map((name) => JSON.parse(readFileSync(join(args[1], name), 'utf8')));
  assert.ok(reports.length > 0, 'no JSON reports found');
  assert.ok(reports.every((report) => report.success === true), 'refusing durations from a failing run');
  const observed = durationsFromReports(reports, root);
  const merged = mergeDurations(readDurations(), observed, (file) => existsSync(join(root, file)));
  const temporary = `${durationsPath}.${process.pid}.tmp`;
  writeFileSync(temporary, serializeDurations(merged));
  renameSync(temporary, durationsPath);
  console.error(`[test-shard-plan] recorded ${observed.size} measured files (${merged.size} total) in ${relative(root, durationsPath)}`);
}
