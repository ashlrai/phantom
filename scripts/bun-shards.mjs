#!/usr/bin/env node
/** Explicit-inventory Bun planning and per-file wall-clock calibration. */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { planShards } from './test-shard-plan.mjs';

const schema = 'phantom-bun-timings/v1';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function inventory(files, root) {
  assert.ok(Array.isArray(files) && files.length, 'inventory must be a nonempty array');
  const base = realpathSync(root);
  const rows = files.map((file) => {
    assert.ok(typeof file === 'string' && !isAbsolute(file) && !file.includes('\\'), 'expected relative test path');
    const path = relative(base, realpathSync(resolve(base, file)));
    assert.ok(path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path), 'test escapes root');
    const normalized = path.split(sep).join('/');
    assert.ok(/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized), 'expected a test file');
    const stat = statSync(resolve(base, path));
    assert.ok(stat.isFile(), 'expected a regular file');
    return { file: normalized, bytes: Math.max(1, stat.size) };
  }).sort((a, b) => compare(a.file, b.file));
  assert.equal(new Set(rows.map((row) => row.file)).size, rows.length, 'duplicate inventory file');
  return rows;
}

export function parseTimings(text) {
  const doc = JSON.parse(text);
  assert.equal(doc?.schema, schema, 'unsupported Bun timings schema');
  assert.ok(doc.files && typeof doc.files === 'object' && !Array.isArray(doc.files), 'expected timing files');
  for (const [file, ms] of Object.entries(doc.files)) {
    assert.ok(file && Number.isFinite(ms) && ms > 0, 'durations must be positive milliseconds');
  }
  return new Map(Object.entries(doc.files));
}

export function readTimings(path) {
  try { return parseTimings(readFileSync(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

export function planBunShards(rows, timings, count) {
  // Convert byte estimates to milliseconds using observed ms/byte. Without
  // observations, weights remain bytes; never label those as elapsed time.
  const known = rows.filter(({ file }) => timings.has(file));
  const scale = known.length
    ? known.reduce((sum, row) => sum + timings.get(row.file), 0) / known.reduce((sum, row) => sum + row.bytes, 0)
    : 1;
  const weights = new Map(rows.map(({ file, bytes }) => [file, timings.get(file) ?? bytes * scale]));
  const { shards } = planShards(rows.map(({ file }) => file), weights, count);
  return {
    unit: known.length ? 'estimated-ms' : 'bytes',
    fallbackFiles: rows.filter(({ file }) => !timings.has(file)).map(({ file }) => file),
    shards: shards.map(({ files, estimatedMs }, index) => ({ index: index + 1, files, weight: estimatedMs })),
  };
}

export function recordTimings(rows, root, run = spawnSync, now = () => performance.now()) {
  const files = {};
  for (const { file } of rows) {
    const start = now();
    // './' makes Bun interpret each argument as an exact path, not a filter.
    const result = run('bun', ['test', `./${file}`], { cwd: root, stdio: 'inherit', timeout: 300_000 });
    assert.ok(!result.error && !result.signal && result.status === 0, `Bun failed for ${file}`);
    files[file] = Math.max(1, Math.round(now() - start));
  }
  return `${JSON.stringify({ schema, files }, null, 2)}\n`;
}

export function main(args) {
  const [mode, inventoryPath, timingPath, shardCount] = args;
  assert.ok((mode === 'plan' && args.length === 4) || (mode === 'record' && args.length === 3),
    'Usage: node scripts/bun-shards.mjs plan <inventory.json> <timings.json> <N> | record <inventory.json> <timings.json>');
  const root = process.cwd();
  const rows = inventory(JSON.parse(readFileSync(inventoryPath, 'utf8')), root);
  if (mode === 'plan') {
    console.log(JSON.stringify(planBunShards(rows, readTimings(timingPath), Number(shardCount)), null, 2));
  } else {
    const text = recordTimings(rows, root);
    // Publish only after every file passes; a failed calibration leaves the
    // previous complete timings untouched. Use separate outputs per runner.
    const temporary = `${timingPath}.${process.pid}.tmp`;
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, timingPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
