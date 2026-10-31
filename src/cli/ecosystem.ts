/**
 * `ashlr ecosystem`: read-only sibling repository diagnostics and the
 * cross-repo changelog document (`ecosystem-changelog.v1`).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { collectEcosystemChangelog } from '../core/ecosystem/changelog.js';
import {
  ECOSYSTEM_CHANGELOG_JSON_PATH,
  ECOSYSTEM_CHANGELOG_MARKDOWN_PATH,
  parseEcosystemChangelogSince,
  renderEcosystemChangelogDocument,
  renderEcosystemChangelogJson,
  renderEcosystemChangelogMarkdown,
} from '../core/ecosystem/changelog-document.js';
import { defaultEcosystemRoot, nearestRepoRoot, runEcosystemDoctor, type EcosystemDoctorCheck, type EcosystemDoctorReport } from '../core/ecosystem/doctor.js';
import { isTty, makeColors, pad } from './ui.js';

interface ParsedEcosystemArgs {
  sub: 'doctor' | 'changelog' | 'help';
  json: boolean;
  deep: boolean;
  root: string | undefined;
  since: string | undefined;
  asOf: string | undefined;
  maxPages: number | undefined;
  write: boolean;
  help: boolean;
  error: string | undefined;
}

function parseArgs(args: string[]): ParsedEcosystemArgs {
  const parsed: ParsedEcosystemArgs = {
    sub: args[0] === 'doctor' || args[0] === 'changelog' ? args[0] : 'help',
    json: false,
    deep: false,
    root: undefined,
    since: undefined,
    asOf: undefined,
    maxPages: undefined,
    write: false,
    help: false,
    error: undefined,
  };

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    parsed.help = true;
    return parsed;
  }

  if (args[0] !== 'doctor' && args[0] !== 'changelog') {
    parsed.error = `unknown ecosystem subcommand: ${args[0]}`;
    return parsed;
  }

  const value = (i: number, flag: string): string | undefined => {
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      parsed.error = `${flag} requires a value`;
      return undefined;
    }
    return next;
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const doctorOnly = parsed.sub === 'doctor';
    if (arg === '--json') {
      parsed.json = true;
    } else if (doctorOnly && arg === '--deep') {
      parsed.deep = true;
    } else if (!doctorOnly && arg === '--write') {
      parsed.write = true;
    } else if (arg === '--root') {
      const v = value(i, arg);
      if (v === undefined) break;
      parsed.root = resolve(v);
      i += 1;
    } else if (!doctorOnly && arg === '--since') {
      const v = value(i, arg);
      if (v === undefined) break;
      parsed.since = v;
      i += 1;
    } else if (!doctorOnly && arg === '--as-of') {
      const v = value(i, arg);
      if (v === undefined) break;
      parsed.asOf = v;
      i += 1;
    } else if (!doctorOnly && arg === '--max-pages') {
      const v = value(i, arg);
      if (v === undefined) break;
      const pages = Number(v);
      if (!Number.isInteger(pages) || pages < 1 || pages > 100) {
        parsed.error = '--max-pages requires an integer from 1 to 100';
        break;
      }
      parsed.maxPages = pages;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg.startsWith('--')) {
      parsed.error = `unknown flag: ${arg}`;
      break;
    } else {
      parsed.error = `unexpected argument: ${arg}`;
      break;
    }
  }

  return parsed;
}

function printHelp(): void {
  const { bold, cyan, dim } = makeColors(isTty());
  process.stdout.write('\n');
  process.stdout.write(bold('  ashlr ecosystem') + dim(' - read-only sibling repo diagnostics and changelog') + '\n');
  process.stdout.write('\n');
  process.stdout.write('  ' + bold('Usage:') + '\n');
  process.stdout.write(`    ${cyan('ashlr ecosystem doctor')} [--json] [--root <dir>] [--deep]\n`);
  process.stdout.write(`    ${cyan('ashlr ecosystem changelog')} [--json] [--root <dir>] [--since <window>] [--as-of <ts>] [--max-pages <n>] [--write]\n`);
  process.stdout.write('\n');
  process.stdout.write('  ' + bold('Changelog options:') + '\n');
  process.stdout.write(`    ${cyan(pad('--json', 18))} Emit the ecosystem-changelog.v1 document as JSON.\n`);
  process.stdout.write(`    ${cyan(pad('--since <window>', 18))} Keep dated changes at or after <N>d, <N>h or an ISO date.\n`);
  process.stdout.write(`    ${cyan(pad('', 18))} Undated (unreleased) changelog sections always pass.\n`);
  process.stdout.write(`    ${cyan(pad('--as-of <ts>', 18))} Anchor instant for --since and generatedAt (ISO; default now).\n`);
  process.stdout.write(`    ${cyan(pad('--max-pages <n>', 18))} Cap GitHub pages per source and repo (1-100; default 10).\n`);
  process.stdout.write(`    ${cyan(pad('--write', 18))} Write ECOSYSTEM_CHANGELOG.md and ${ECOSYSTEM_CHANGELOG_JSON_PATH} to the repo root.\n`);
  process.stdout.write('\n');
  process.stdout.write('  ' + bold('Doctor options:') + '\n');
  process.stdout.write(`    ${cyan(pad('--json', 18))} Emit {generatedAt, root, summary, checks, repos} as JSON.\n`);
  process.stdout.write(`    ${cyan(pad('--root <dir>', 18))} Scan immediate sibling repos under this directory.\n`);
  process.stdout.write(`    ${cyan(pad('--deep', 18))} Add extra read-only git/package/docs probes.\n`);
  process.stdout.write('\n');
  process.stdout.write('  ' + dim('Never runs package scripts, builds, tests, or package managers; writes nothing without --write.') + '\n');
  process.stdout.write('  ' + dim('Exit status is 1 when any changelog source is incomplete, truncated or unavailable.') + '\n');
  process.stdout.write('\n');
}

const GLYPH: Record<EcosystemDoctorCheck['status'], string> = {
  pass: 'ok',
  warn: '!',
  fail: 'x',
};

function formatStatus(check: EcosystemDoctorCheck): string {
  const { green, yellow, red } = makeColors(isTty());
  const raw = `${GLYPH[check.status]} ${check.status}`;
  if (check.status === 'pass') return green(raw);
  if (check.status === 'warn') return yellow(raw);
  return red(raw);
}

function printHuman(report: EcosystemDoctorReport): void {
  const { bold, cyan, dim, gray, green, red, yellow } = makeColors(isTty());
  process.stdout.write('\n');
  process.stdout.write(bold('  ashlr ecosystem doctor') + gray(` — ${new Date(report.generatedAt).toLocaleString()}`) + '\n');
  process.stdout.write(dim(`  root: ${report.root}`) + '\n');
  process.stdout.write('\n');

  const repoW = Math.max(4, ...report.repos.map((repo) => repo.name.length));
  process.stdout.write(
    '  ' +
      gray(pad('REPO', repoW)) +
      '  ' + gray(pad('STATUS', 8)) +
      '  ' + gray(pad('GIT', 24)) +
      '  ' + gray(pad('PACKAGE', 26)) +
      '  ' + gray('DOCS') +
      '\n',
  );

  if (report.repos.length === 0) {
    process.stdout.write('  ' + dim('(no sibling repos found)') + '\n');
  }

  for (const repo of report.repos) {
    const worst = repo.summary.fail > 0 ? 'fail' : repo.summary.warn > 0 ? 'warn' : 'pass';
    const git = repo.git
      ? `${repo.git.branch ?? 'detached'}${repo.git.dirty > 0 ? `, ${repo.git.dirty} dirty` : ''}`
      : 'unreadable';
    const pkg = repo.package
      ? `${repo.package.name ?? 'unnamed'}${repo.package.version ? `@${repo.package.version}` : ''}`
      : 'missing';
    const docs = repo.docs.readme || repo.docs.docsMarkdown > 0
      ? `${repo.docs.readme ? 'README' : 'no README'}, ${repo.docs.docsMarkdown} docs`
      : 'missing';
    process.stdout.write(
      '  ' +
        cyan(pad(repo.name, repoW)) +
        '  ' + pad(worst === 'pass' ? green('pass') : worst === 'warn' ? yellow('warn') : red('fail'), 8) +
        '  ' + pad(git, 24) +
        '  ' + pad(pkg, 26) +
        '  ' + dim(docs) +
        '\n',
    );
  }

  const notable = report.checks.filter((check) => check.status !== 'pass');
  if (notable.length > 0) {
    process.stdout.write('\n');
    process.stdout.write('  ' + bold('Findings') + '\n');
    for (const check of notable) {
      const repo = check.repo ? `${check.repo}: ` : '';
      process.stdout.write(`  ${pad(formatStatus(check), 8)}  ${repo}${check.label} — ${dim(check.detail)}\n`);
    }
  }

  process.stdout.write('\n');
  process.stdout.write(
    `  ${green(`${report.summary.pass} pass`)}  ` +
      `${yellow(`${report.summary.warn} warn`)}  ` +
      `${red(`${report.summary.fail} fail`)}  ` +
      dim(`across ${report.summary.repos} repo(s)`) +
      '\n',
  );
  process.stdout.write('\n');
}

async function runChangelog(parsed: ParsedEcosystemArgs): Promise<number> {
  const { red } = makeColors(isTty());
  const asOf = parsed.asOf ?? new Date().toISOString();
  let since: string | null;
  try {
    since = parseEcosystemChangelogSince(parsed.since, asOf);
  } catch (error) {
    process.stderr.write(red('error: ') + (error instanceof Error ? error.message : String(error)) + '\n');
    return 2;
  }
  const report = await collectEcosystemChangelog({
    root: parsed.root ?? defaultEcosystemRoot(),
    maxPages: parsed.maxPages,
  });
  const document = renderEcosystemChangelogDocument(report, { asOf, since });
  if (parsed.write) {
    const repoRoot = nearestRepoRoot(process.cwd());
    if (repoRoot === null) {
      process.stderr.write(red('error: ') + '--write requires running inside a repository checkout\n');
      return 2;
    }
    const markdownPath = join(repoRoot, ECOSYSTEM_CHANGELOG_MARKDOWN_PATH);
    const jsonPath = join(repoRoot, ECOSYSTEM_CHANGELOG_JSON_PATH);
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(markdownPath, renderEcosystemChangelogMarkdown(document), 'utf8');
    await writeFile(jsonPath, renderEcosystemChangelogJson(document), 'utf8');
    process.stderr.write(`wrote ${markdownPath}\nwrote ${jsonPath}\n`);
    return document.complete ? 0 : 1;
  }
  process.stdout.write(parsed.json ? renderEcosystemChangelogJson(document) : renderEcosystemChangelogMarkdown(document));
  return document.complete ? 0 : 1;
}

export async function cmdEcosystem(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    printHelp();
    return parsed.error ? 2 : 0;
  }
  if (parsed.error) {
    const { red } = makeColors(isTty());
    process.stderr.write(red('error: ') + parsed.error + '\n');
    return 2;
  }
  if (parsed.sub === 'changelog') {
    return runChangelog(parsed);
  }
  if (parsed.sub !== 'doctor') {
    printHelp();
    return 2;
  }

  const report = await runEcosystemDoctor({ root: parsed.root, deep: parsed.deep });
  if (parsed.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printHuman(report);
  }
  return report.summary.fail > 0 ? 1 : 0;
}
