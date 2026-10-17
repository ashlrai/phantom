#!/usr/bin/env node
/** Fixed synthetic source-checkout evaluator, executed with existing tsx. No install/build/model/provider fallback. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = 'test/fixtures/memory/corpus-v1.json';
const SOURCES = ['src/core/memory/types.ts', 'src/core/memory/validate.ts', 'src/core/memory/scope.ts', 'src/core/memory/temporal.ts', 'src/core/memory/pack.ts',
  'src/core/local-eval/memory-evaluation-types.ts', 'src/core/local-eval/memory-evaluation-baseline.ts', 'src/core/local-eval/memory-evaluation.ts',
  'src/core/local-eval/memory-performance.ts', 'src/core/authority/canonical-json.ts', 'src/core/util/scrub-secrets.ts'];
const digest = (bytes: string | Uint8Array) => 'sha256_' + createHash('sha256').update(bytes).digest('hex');
export function parseMemoryEvaluationArgs(argv: string[]) {
  if (!Array.isArray(argv) || argv.length > 1 || argv.length === 1 && argv[0] !== '--json') throw new Error('MEMORY_EVAL_ARGUMENTS');
  return { json: true };
}
/** Reads fixed checkout artifacts through a bounded stable regular file; never arbitrary user exports. */
export function readFixedMemoryEvaluationFile(root: string, relative: string, maxBytes = 1024 * 1024) {
  if (typeof relative !== 'string' || relative.includes('..') || relative.startsWith('/') || relative.includes('\\')
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error('MEMORY_EVAL_INPUT');
  const physicalRoot = realpathSync(root); const path = join(physicalRoot, relative); const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || !realpathSync(path).startsWith(physicalRoot + sep)) throw new Error('MEMORY_EVAL_INPUT');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const first = fstatSync(fd);
    if (!first.isFile() || first.size > maxBytes || first.dev !== before.dev || first.ino !== before.ino) throw new Error('MEMORY_EVAL_INPUT');
    const buffer = Buffer.alloc(maxBytes + 1); let used = 0;
    while (used < buffer.length) { const count = readSync(fd, buffer, used, buffer.length - used, null); if (!count) break; used += count; }
    const after = fstatSync(fd); const current = lstatSync(path);
    if (used > maxBytes || first.size !== used || after.size !== first.size || after.mtimeMs !== first.mtimeMs
      || after.ctimeMs !== first.ctimeMs || current.dev !== first.dev || current.ino !== first.ino || current.isSymbolicLink()) throw new Error('MEMORY_EVAL_INPUT');
    return { bytes: buffer.subarray(0, used), modifiedAt: first.mtimeMs };
  } finally { closeSync(fd); }
}
function git(args: string[]) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('MEMORY_EVAL_SOURCE');
  return result.stdout.trim();
}
function capture() {
  const sourceFiles = [...SOURCES, 'scripts/evaluate-memory.ts', CORPUS].map(path => {
    const read = readFixedMemoryEvaluationFile(ROOT, path); return { path, bytes: read.bytes.length, digest: digest(read.bytes), modifiedAt: read.modifiedAt };
  });
  const sha = git(['rev-parse', 'HEAD']); const tree = git(['rev-parse', 'HEAD^{tree}']);
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[a-f0-9]{40}$/.test(tree)) throw new Error('MEMORY_EVAL_SOURCE');
  return { sourceFiles, sourceBinding: { sha, tree, dirty: Boolean(git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'])),
    workingSourceDigest: digest(JSON.stringify(sourceFiles.map(file => ({ path: file.path, bytes: file.bytes, digest: file.digest })))) } };
}
export async function evaluateMemoryCli(argv = process.argv.slice(2)) {
  try {
    parseMemoryEvaluationArgs(argv);
    const before = capture();
    const corpusBytes = readFixedMemoryEvaluationFile(ROOT, CORPUS).bytes;
    if (digest(corpusBytes) !== before.sourceFiles.find(file => file.path === CORPUS)?.digest) throw new Error('MEMORY_EVAL_SOURCE_CHANGED');
    const corpus = new TextDecoder('utf-8', { fatal: true }).decode(corpusBytes);
    const { runMemoryEvaluation } = await import('../src/core/local-eval/memory-evaluation.js');
    const { profileMemoryKernel, profilePreparedMemoryKernel } = await import('../src/core/local-eval/memory-performance.js');
    const report = runMemoryEvaluation(corpus, before.sourceBinding, { repeats: 3 });
    const profiles = [profileMemoryKernel(20261014, 128, 10), profileMemoryKernel(20261014, 1024, 10)];
    const pairedProfiles = [profilePreparedMemoryKernel(20261014, 128, 10), profilePreparedMemoryKernel(20261014, 1024, 10)];
    const after = capture();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('MEMORY_EVAL_SOURCE_CHANGED');
    const governed = report.arms.find(arm => arm.arm === 'governed');
    return { exitCode: governed && governed.assigned === 72 && governed.failed === 0 && governed.unknown === 0 && governed.passed === 72 ? 0 : 1,
      output: { capturedAt: new Date().toISOString(), report, profiles, pairedProfiles, runnerEvidence: { sourceFiles: before.sourceFiles,
        executionMode: 'source-executed-with-existing-tsx', sourceObservation: 'not-signed-or-installed-attestation', rawCorpusDigest: digest(corpusBytes) } } };
  } catch (error) {
    const code = error instanceof Error && ['MEMORY_EVAL_ARGUMENTS', 'MEMORY_EVAL_SOURCE_CHANGED'].includes(error.message) ? error.message : 'MEMORY_EVAL_UNAVAILABLE';
    return { exitCode: 2, output: { code, error: code === 'MEMORY_EVAL_ARGUMENTS' ? 'Usage: npm run eval:memory -- [--json]. Only the bundled synthetic corpus is supported.'
      : 'The synthetic memory evaluation could not be confirmed. Use an unchanged source checkout with its existing dependencies and retry. No installation or build is started automatically.' } };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await evaluateMemoryCli(); process.stdout.write(JSON.stringify(result.output, null, 2) + '\n'); process.exitCode = result.exitCode;
}
