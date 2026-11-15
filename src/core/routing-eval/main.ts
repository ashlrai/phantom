/**
 * Offline routing eval. Reads the checked-in corpus, scores it, prints JSON,
 * and writes the same JSON under eval/routing/out. No network and no keys.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluateRoutingCorpus, parseRoutingEvalCorpus } from './report.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORPUS_PATH = join(ROOT, 'test', 'fixtures', 'routing-eval', 'corpus.json');
const OUT_PATH = join(ROOT, 'eval', 'routing', 'out', 'routing-eval.json');

function main(): number {
  const raw = readFileSync(CORPUS_PATH, 'utf8');
  const corpus = parseRoutingEvalCorpus(JSON.parse(raw) as unknown);
  const report = evaluateRoutingCorpus(corpus);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, json);
  process.stdout.write(json);
  const failed = report.mismatches.length > 0
    || report.modelCalls !== 0
    || report.invariantViolations.length > 0;
  return failed ? 1 : 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  try {
    process.exit(main());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'routing eval failed';
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }
}
