#!/usr/bin/env node
/**
 * scripts/docs-sync.mjs — living-docs sync: regenerate every committed file
 * whose content the repository generates, in one pass.
 *
 *   node --import tsx scripts/docs-sync.mjs              plan: report fresh/stale, write nothing
 *   node --import tsx scripts/docs-sync.mjs --check      exit 1 when any surface is stale or fails
 *   node --import tsx scripts/docs-sync.mjs --write      write the stale files (alias: --apply)
 *   node --import tsx scripts/docs-sync.mjs --json       print the machine-readable plan/report
 *
 * Surfaces (--surface <name>, repeatable or comma-separated):
 *   cli            docs/cli.md          <- phm --help + phm help --all
 *   cli-reference  docs/CLI-REFERENCE.md <- the same captures
 *   llms           docs/llms.txt        <- generated docs page index block
 *   codemap        docs/CODEMAP.md      <- src/ and src/core/ directory blocks
 *   changelog      CHANGELOG.md         <- changelog-sync block in Unreleased
 *
 * Changelog evidence (see scripts/CHANGELOG-SYNC.md for the snapshot contract):
 *   --changelog-snapshot <file>   scoped GitHub snapshot (PR titles + numbers)
 *   --changelog-base <40-hex>     local commits since this commit; default is
 *                                 the most recent release tag when one exists
 *
 * Options: --root <dir> (another checkout), --check, --write/--apply, --json,
 * --surface <name>, --changelog-snapshot <file>, --changelog-base <sha>,
 * --help.
 *
 * Exit codes: 0 ok (or plan/report printed), 1 stale on --check or a surface
 * failed, 2 bad usage. Local reads and writes only — never commits, pushes or
 * opens pull requests; the report's `proposal` field is the PR title/body a
 * publishing lane can use verbatim. See docs/LIVING-DOCS.md.
 *
 * `--import tsx` is required: the CLI-REFERENCE renderer lives in TypeScript
 * (scripts/generate-cli-reference.ts), matching that script's own invocation.
 */
import { resolve } from 'node:path';
import console from 'node:console';
import process from 'node:process';

import { LIVING_DOC_SURFACE_NAMES, syncDocs } from './lib/living-docs.mjs';

const USAGE = `Usage: node --import tsx scripts/docs-sync.mjs [--check | --write] [--json]
  [--root <dir>] [--surface <name>[,<name>...]]
  [--changelog-snapshot <file> | --changelog-base <sha>]

Surfaces: ${LIVING_DOC_SURFACE_NAMES.join(', ')} (default: all)
`;

function parseArgs(argv) {
  const options = { surfaces: [], changelog: {} };
  const takeValue = (args, i, flag) => {
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help': case '-h': options.help = true; break;
      case '--check': options.check = true; break;
      case '--write': case '--apply': options.write = true; break;
      case '--json': options.json = true; break;
      case '--root': options.root = takeValue(argv, i, arg); i++; break;
      case '--surface':
        options.surfaces.push(...takeValue(argv, i, arg).split(',').map((s) => s.trim()).filter(Boolean));
        i++;
        break;
      case '--changelog-snapshot': options.changelog.snapshotFile = takeValue(argv, i, arg); i++; break;
      case '--changelog-base': options.changelog.base = takeValue(argv, i, arg); i++; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.check && options.write) throw new Error('--check and --write are mutually exclusive');
  if (options.changelog.snapshotFile && options.changelog.base) {
    throw new Error('--changelog-snapshot and --changelog-base are mutually exclusive');
  }
  return options;
}

function printHuman(report) {
  const width = Math.max(...report.surfaces.map((s) => s.name.length));
  for (const r of report.surfaces) {
    const note = r.detail ? ` — ${r.detail}`
      : r.firstDifference ? ` — first difference at line ${r.firstDifference.line}`
      : '';
    console.log(`  ${r.name.padEnd(width)}  ${r.status.padEnd(8)} ${r.path}${note}`);
  }
  const stale = report.surfaces.filter((r) => r.status === 'stale').length;
  const written = report.surfaces.filter((r) => r.status === 'written').length;
  const failed = report.surfaces.filter((r) => r.status === 'error').length;
  const skipped = report.surfaces.filter((r) => r.status === 'skipped').length;
  const parts = [];
  if (stale) parts.push(`${stale} stale`);
  if (written) parts.push(`${written} written`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (failed) parts.push(`${failed} failed`);
  console.log(
    parts.length
      ? `docs-sync: ${parts.join(', ')}${stale ? ' — run with --write to regenerate' : ''}`
      : 'docs-sync: all generated surfaces are fresh',
  );
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const report = syncDocs({
    root: options.root ? resolve(options.root) : undefined,
    write: options.write === true,
    surfaces: options.surfaces.length ? options.surfaces : undefined,
    changelog: Object.keys(options.changelog).length ? options.changelog : undefined,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
    if (report.proposal) {
      console.log('\nProposal for the publishing lane (--json prints it as fields):');
      console.log(`  ${report.proposal.title}`);
    }
  }
  if (options.check) process.exit(report.ok ? 0 : 1);
  process.exit(report.surfaces.some((r) => r.status === 'error') ? 1 : 0);
} catch (error) {
  console.error(`docs-sync: ${error instanceof Error ? error.message : String(error)}`);
  console.error(USAGE.trim());
  process.exit(2);
}
