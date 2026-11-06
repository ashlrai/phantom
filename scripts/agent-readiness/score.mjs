#!/usr/bin/env node
/**
 * score.mjs - offline agentic-readiness scorer.
 *
 * Scores a local site build dir or a repo checkout against the
 * agent-readiness rubric (docs/AGENT-READINESS.md) and emits one
 * agent-readiness.v1 JSON artifact per target. Artifacts are written to the
 * shared metrics inputs directory ($ASHLR_HOME/metrics/agent-readiness or
 * ~/.ashlr/metrics/agent-readiness) where RQ-METRICS-IMPACT-SCORE reads
 * inputs, so an impact reader can reward score gains between runs.
 *
 * No network access and no model calls. The scoring logic lives in
 * src/core/observability/agent-readiness.ts; this script needs a built dist
 * (npm run build) unless it is only printing --help.
 *
 * Usage:
 *   node scripts/agent-readiness/score.mjs [--site DIR]... [--repo DIR]...
 *                                          [--target DIR]... [--out DIR]
 *                                          [--label NAME] [--json] [--no-write]
 *
 *   --site DIR    score DIR as a built site (pages, sitemap, llms.txt, meta)
 *   --repo DIR    score DIR as a repo checkout (AGENTS.md, llms.txt,
 *                 capabilities, server.json)
 *   --target DIR  auto-detect kind: a dir with HTML files at its root is a
 *                 site, anything else is a repo
 *   --out DIR     artifact directory (default: the metrics inputs dir above)
 *   --label NAME  artifact slug override (only valid with one target)
 *   --json        print a machine-readable run report on stdout
 *   --no-write    score only; do not write artifacts
 *
 * Exit codes: 0 success, 1 unreadable target or malformed existing artifact,
 * 2 usage error.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const MODULE_URL = pathToFileURL(join(repoRoot, 'dist/core/observability/agent-readiness.js')).href;

const USAGE = `Usage: node scripts/agent-readiness/score.mjs [--site DIR]... [--repo DIR]... [--target DIR]... [--out DIR] [--label NAME] [--json] [--no-write]`;

function usageError(message) {
  console.error(`error: ${message}\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const targets = [];
  let out = null;
  let label = null;
  let json = false;
  let write = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const value = argv[++i];
      if (value === undefined) usageError(`${arg} requires a value`);
      return value;
    };
    if (arg === '--site') targets.push({ kind: 'site', dir: take() });
    else if (arg === '--repo') targets.push({ kind: 'repo', dir: take() });
    else if (arg === '--target') targets.push({ kind: 'auto', dir: take() });
    else if (arg === '--out') out = take();
    else if (arg === '--label') label = take();
    else if (arg === '--json') json = true;
    else if (arg === '--no-write') write = false;
    else if (arg === '--help' || arg === '-h') { return { help: true }; }
    else usageError(`unknown argument: ${arg}`);
  }
  if (label && targets.length !== 1) usageError('--label requires exactly one target');
  return { help: false, targets, out, label, json, write };
}

function detectKind(dir) {
  try {
    return readdirSync(dir).some((name) => /\.(html?|xhtml)$/i.test(name)) ? 'site' : 'repo';
  } catch {
    return 'repo';
  }
}

function defaultOutDir() {
  const configured = process.env['ASHLR_HOME'];
  const home = configured && isAbsolute(configured) ? configured : join(homedir(), '.ashlr');
  return join(home, 'metrics', 'agent-readiness');
}

async function loadModule() {
  try {
    return await import(MODULE_URL);
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('error: dist/ is not built. Run `npm run build` first, then retry.');
      process.exit(1);
    }
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    console.log('Scores a site build dir or repo checkout for agentic readiness.');
    console.log('See docs/AGENT-READINESS.md for the rubric and artifact contract.');
    return 0;
  }
  if (!args.targets.length) usageError('at least one --site, --repo or --target is required');
  const mod = await loadModule();
  const outDir = resolve(args.out ?? defaultOutDir());
  const reports = [];
  for (const target of args.targets) {
    const dir = resolve(target.dir);
    if (!existsSync(dir)) {
      console.error(`error: target does not exist: ${dir}`);
      process.exit(1);
    }
    const kind = target.kind === 'auto' ? detectKind(dir) : target.kind;
    try {
      reports.push(mod.scoreAgentReadinessDir({
        kind,
        dir,
        ...(args.label ? { label: args.label } : {}),
      }));
    } catch (error) {
      console.error(`error: cannot score ${dir}: ${error.message}`);
      process.exit(1);
    }
  }
  let written = [];
  if (args.write) {
    try {
      written = mod.writeAgentReadinessArtifacts(reports, outDir);
    } catch (error) {
      console.error(`error: cannot write artifacts under ${outDir}: ${error.message}`);
      process.exit(1);
    }
  }
  const paths = new Map(written.map((w) => [w.report, w.path]));
  if (args.json) {
    const body = {
      schema: 'agent-readiness-run.v1',
      outDir: args.write ? outDir : null,
      reports: (args.write ? written.map((w) => w.report) : reports),
    };
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  for (const report of args.write ? written.map((w) => w.report) : reports) {
    const delta = report.delta === null ? '' : ` (delta ${report.delta > 0 ? '+' : ''}${report.delta})`;
    console.log(`${report.target.kind} ${report.target.path}: ${report.score}/100${delta}`);
    for (const check of report.checks) {
      const mark = check.applicable ? `${check.points}/${check.weight}` : 'n/a';
      console.log(`  ${check.id.padEnd(13)} ${mark}`);
    }
    const path = paths.get(report);
    if (path) console.log(`  wrote ${path}`);
  }
  return 0;
}

main().then((code) => process.exit(code ?? 0), (error) => {
  console.error(`error: ${error?.message ?? error}`);
  process.exit(1);
});
