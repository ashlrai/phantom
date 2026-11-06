#!/usr/bin/env node
/**
 * scripts/generate-cli-docs.mjs - regenerate docs/cli.md from `phm --help`.
 *
 * docs/cli.md is generated, not authored: it embeds the CLI's own help
 * surfaces so the published command reference can never drift from the
 * binary a user runs. After changing help text in src/cli/, regenerate:
 *
 *   node scripts/generate-cli-docs.mjs           rewrite docs/cli.md
 *   node scripts/generate-cli-docs.mjs --check   exit 1 when docs/cli.md is stale
 *
 * The CLI runs from source through tsx in a disposable HOME with NO_COLOR=1,
 * so captured output is deterministic and ANSI-free. Non-ASCII dashes are
 * written as `-` and trailing whitespace is stripped for docs style.
 * test/cli-docs-drift.test.ts holds the committed file to this output.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_DOC_PATH = 'docs/cli.md';
const CLI_ENTRY = join('src', 'cli', 'index.ts');
const CHILD_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The `phm --help` family surfaces captured into docs/cli.md, in doc order. */
const SURFACES = [
  { title: 'phm --help', args: ['--help'], note: 'Topic summary and discovery hints.' },
  { title: 'phm help --all', args: ['help', '--all'], note: 'Every command, grouped by topic.' },
];

// eslint-disable-next-line no-control-regex -- matching the ESC that opens a terminal style is the point
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const NON_ASCII_DASH_RE = /[\u2010-\u2015\u2212]/g;

/**
 * Make captured help output stable and docs-safe across platforms and
 * environments: LF endings, no ANSI styling, no trailing whitespace,
 * no leading or trailing blank lines, and ASCII dashes.
 */
export function normalizeHelpOutput(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_RE, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(NON_ASCII_DASH_RE, '-')
    .replace(/^\n+/, '')
    .replace(/[\n \t]+$/, '\n');
}

/** Run `phm <args>` from source through tsx in the given scratch HOME. */
export function captureHelpOutput(args, { repoRoot = REPO_ROOT, home }) {
  let tsxLoader;
  try {
    tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  } catch {
    throw new Error('tsx is required to run the CLI from source; run `npm ci` first');
  }
  const result = spawnSync(
    process.execPath,
    ['--import', tsxLoader, join(repoRoot, CLI_ENTRY), ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`phm ${args.join(' ')} exited ${String(result.status)}:\n${String(result.stderr).slice(0, 2000)}`);
  }
  return normalizeHelpOutput(result.stdout);
}

/** Compose the generated document from captured sections. */
export function renderCliDoc(sections) {
  const parts = [
    '# Phantom CLI reference',
    '',
    'Generated from `phm --help` output by `scripts/generate-cli-docs.mjs`;',
    'do not edit by hand. After changing help text in `src/cli/`, regenerate:',
    '',
    '    node scripts/generate-cli-docs.mjs',
    '',
    'The drift guard `test/cli-docs-drift.test.ts` fails when this file no',
    'longer matches current help output. Non-ASCII dashes are written as `-`',
    'and ANSI styling is stripped; `phm <command> --help` stays the',
    'per-command detail surface.',
    '',
  ];
  for (const { title, note, output } of sections) {
    parts.push(`## \`${title}\``, '', note, '', '```text', output.replace(/\n$/, ''), '```', '');
  }
  return parts.join('\n');
}

/** Capture every configured surface and return the full document text. */
export function buildCliDocs({ repoRoot = REPO_ROOT } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'phm-cli-docs-'));
  try {
    const sections = SURFACES.map(({ title, args, note }) => ({
      title,
      note,
      output: captureHelpOutput(args, { repoRoot, home }),
    }));
    return renderCliDoc(sections);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Compare the committed doc with fresh output without writing anything. */
export function checkCliDocs(repoRoot = REPO_ROOT) {
  const docPath = join(repoRoot, CLI_DOC_PATH);
  const actual = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';
  const expected = buildCliDocs({ repoRoot });
  return { ok: actual === expected, docPath, expected, actual };
}

/** First differing line between two texts, or null when identical. */
export function firstDiff(actual, expected) {
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const count = Math.max(actualLines.length, expectedLines.length);
  for (let i = 0; i < count; i += 1) {
    if (actualLines[i] !== expectedLines[i]) {
      return { line: i + 1, actual: actualLines[i], expected: expectedLines[i] };
    }
  }
  return null;
}

function main(args) {
  const check = args.includes('--check');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: node scripts/generate-cli-docs.mjs [--check]');
    console.log('  (no args) rewrite docs/cli.md from `phm --help` output');
    console.log('  --check   compare only; exit 1 when docs/cli.md is stale');
    return 0;
  }
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`unknown argument ${unknown[0]}; usage: node scripts/generate-cli-docs.mjs [--check]`);
    return 2;
  }

  if (check) {
    const result = checkCliDocs();
    if (result.ok) {
      console.log(`${CLI_DOC_PATH} is up to date.`);
      return 0;
    }
    console.error(`${CLI_DOC_PATH} is stale or missing; run \`node scripts/generate-cli-docs.mjs\`.`);
    const diff = firstDiff(result.actual, result.expected);
    if (diff) {
      console.error(`first difference at line ${diff.line}:`);
      console.error(`  committed: ${diff.actual ?? '<missing>'}`);
      console.error(`  generated: ${diff.expected ?? '<missing>'}`);
    }
    return 1;
  }

  const doc = buildCliDocs();
  writeFileSync(join(REPO_ROOT, CLI_DOC_PATH), doc);
  console.log(`wrote ${CLI_DOC_PATH} (${doc.split('\n').length - 1} lines)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`generate-cli-docs: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
