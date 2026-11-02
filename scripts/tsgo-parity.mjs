#!/usr/bin/env node
/**
 * tsgo-parity.mjs — does tsgo report every error class tsc reports?
 *
 * #2624 lets workers typecheck with tsgo (~139s) where tsc takes >960s under
 * load, but parity was never proven: the tsc side timed out, and the class
 * that actually hurt (TS4058 on PR #2583) was not exercised. This probe
 * settles it empirically:
 *
 *   1. Writes a scratch project under os.tmpdir(): one fixture file per error
 *      class, plus a tsconfig that copies the repo's compilerOptions verbatim
 *      except rootDir (sources sit at the scratch root) and
 *      incremental/tsBuildInfoFile (each compiler must produce cold
 *      diagnostics — a shared tsbuildinfo could let the second compiler skip
 *      re-checking and under-report).
 *   2. Runs `tsc -p tsconfig.json` and `tsgo -p tsconfig.json` on it — real
 *      emit, NOT --noEmit. Under --noEmit tsc skips declaration diagnostics
 *      (TS4058's family) whenever any other error exists, which would make
 *      the TS4058 row vacuous. Verified against tsc 5.9.3 and
 *      tsgo 7.0.0-dev.20260707.2.
 *   3. Prints one JSON line per class: {"code","tscReported","tsgoReported"}.
 *      Exits 1 when tsc reports a class tsgo misses (a parity gap), when tsc
 *      fails to report a class (a broken fixture — nothing was proven), or
 *      when a compiler cannot run at all.
 *
 * Usage: node scripts/tsgo-parity.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PARITY_CASES = [
  {
    code: 'TS4058',
    // Exported function whose inferred return type names a non-exported
    // interface from another module — the declaration emitter cannot name
    // 'Hidden', so `consumer` is a cross-module declaration diagnostic.
    files: {
      'case-ts4058-hidden.ts': 'interface Hidden { value: number }\nexport function makeHidden(): Hidden {\n  return { value: 1 };\n}\n',
      'case-ts4058.ts': "import { makeHidden } from './case-ts4058-hidden.js';\nexport function consumer() {\n  return makeHidden();\n}\n",
    },
  },
  {
    code: 'TS2352',
    files: {
      'case-ts2352.ts': 'export function badCast(value: number): string {\n  return value as string;\n}\n',
    },
  },
  {
    code: 'TS2322',
    files: {
      'case-ts2322.ts': 'export const wrong: number = "hello";\n',
    },
  },
  {
    code: 'TS2345',
    files: {
      'case-ts2345.ts': 'function takesString(s: string): string {\n  return s;\n}\nexport const argMismatch = takesString(123);\n',
    },
  },
  {
    code: 'TS7006',
    files: {
      'case-ts7006.ts': 'export function implicitAny(x) {\n  return x;\n}\n',
    },
  },
  {
    code: 'TS18048',
    files: {
      'case-ts18048.ts': 'export function maybeUndefined(s: string | undefined): number {\n  return s.length;\n}\n',
    },
  },
  {
    code: 'TS2307',
    files: {
      'case-ts2307.ts': "import { missing } from './does-not-exist.js';\nexport const reexported = missing;\n",
    },
  },
];

/** Diagnostic codes mentioned in a compiler's combined stdout+stderr. */
export function parseDiagnosticCodes(output) {
  return new Set([...output.matchAll(/\berror (TS\d+)\b/g)].map((match) => match[1]));
}

/** Per-class reported flags for a pair of compiler outputs. */
export function compareDiagnostics(cases, tscOutput, tsgoOutput) {
  const tsc = parseDiagnosticCodes(tscOutput);
  const tsgo = parseDiagnosticCodes(tsgoOutput);
  return cases.map(({ code }) => ({ code, tscReported: tsc.has(code), tsgoReported: tsgo.has(code) }));
}

/** Classes tsc reported that tsgo did not — the ship-blocking gaps. */
export function parityGaps(results) {
  return results.filter((result) => result.tscReported && !result.tsgoReported).map((result) => result.code);
}

/** Classes tsc did not report — the fixture proved nothing for these. */
export function unprovenCases(results) {
  return results.filter((result) => !result.tscReported).map((result) => result.code);
}

function writeProject(root, dir) {
  const compilerOptions = { ...JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')).compilerOptions, rootDir: '.', incremental: false };
  delete compilerOptions.tsBuildInfoFile;
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify({ compilerOptions, include: ['*.ts'] }, null, 2)}\n`);
  for (const testCase of PARITY_CASES) {
    for (const [name, content] of Object.entries(testCase.files)) {
      writeFileSync(join(dir, name), content);
    }
  }
}

/** Emit-mode diagnostics run; throws on spawn failure, signal or timeout. */
function runCompiler(root, dir, compiler, spawn = spawnSync) {
  const [command, argv] = compiler === 'tsgo'
    ? [join(root, 'node_modules/.bin/tsgo'), ['-p', 'tsconfig.json']]
    : [process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']];
  const target = compiler === 'tsgo' ? command : argv[0];
  if (!existsSync(target)) throw new Error(`${compiler} not found at ${target}; run npm ci`);
  const result = spawn(command, argv, {
    cwd: dir, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL',
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`${compiler} timed out after 120s`);
  if (result.error) throw new Error(`${compiler} failed to start: ${result.error.message}`);
  if (result.signal) throw new Error(`${compiler} died on signal ${result.signal}`);
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

export function main(io = { stdout: (line) => console.log(line), stderr: (line) => console.error(line) }) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'tsgo-parity-'));
  try {
    writeProject(root, dir);
    const tscOutput = runCompiler(root, dir, 'tsc');
    const tsgoOutput = runCompiler(root, dir, 'tsgo');
    const results = compareDiagnostics(PARITY_CASES, tscOutput, tsgoOutput);
    for (const result of results) io.stdout(JSON.stringify(result));
    let failed = false;
    const unproven = unprovenCases(results);
    if (unproven.length) {
      io.stderr(`tsgo-parity: tsc did not report ${unproven.join(', ')} — fixture defect, parity unproven`);
      failed = true;
    }
    const gaps = parityGaps(results);
    if (gaps.length) {
      io.stderr(`tsgo-parity: parity gap — tsgo missed ${gaps.join(', ')}`);
      failed = true;
    }
    return failed ? 1 : 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`tsgo-parity: ${error.message}`);
    process.exitCode = 1;
  }
}
