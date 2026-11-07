#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVitestReport } from './test-fast-report.mjs';

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'phantom-test-fast-'));
const rawReport = join(temp, 'vitest.json');
const output = join(root, '.ashlr-gate', 'test-fast-durations.json');
let exitCode = 1;
try {
  // Remove an earlier report so a failed or interrupted run cannot look current.
  rmSync(output, { force: true });
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./test-ci.mjs', import.meta.url)),
    '--project=unit', '--reporter=default', '--reporter=json',
    `--outputFile.json=${rawReport}`, ...process.argv.slice(2),
  ], { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  exitCode = result.status ?? 1;
  const report = parseVitestReport(JSON.parse(readFileSync(rawReport, 'utf8')), root);
  mkdirSync(join(root, '.ashlr-gate'), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[test:fast] File durations: ${output}`);
  for (const file of report.files.filter((entry) => entry.overBudget)) {
    console.warn(`[test:fast] ${file.file}: ${(file.durationMs / 1000).toFixed(2)}s exceeds 20s. ${file.suggestion}`);
  }
} catch (error) {
  console.error(`[test:fast] Could not produce duration report: ${error.message}`);
  exitCode = exitCode || 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
process.exitCode = exitCode;
