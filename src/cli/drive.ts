import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rejectUnknownOptions } from './args.js';
import { buildDriveReport, parseDriveInputs } from '../core/drive/routines.js';

export async function cmdDrive(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('phm drive [--once] [--root <directory>] [--json]\nReads status.json and jobs.jsonl; writes relay-status.json for Masbot.\nphm drive jobs --bin <absolute-phm-path> [--root <directory>]');
    return 0;
  }
  const jobsMode = args[0] === 'jobs';
  const rest = jobsMode ? args.slice(1) : args;
  const invalid = rejectUnknownOptions(rest, { flags: ['--once', '--json'], values: ['--root', '--bin'] });
  const positionals = rest.filter((token, i) => !token.startsWith('-') && !['--root', '--bin'].includes(rest[i - 1] ?? ''));
  if (invalid || positionals.length || (!jobsMode && rest.includes('--bin'))) {
    console.error(invalid?.message ?? 'Invalid drive arguments');
    return 2;
  }
  const root = rest.includes('--root') ? rest[rest.indexOf('--root') + 1]! : join(homedir(), '.ashlr', 'drive');
  try {
    if (jobsMode) {
      const bin = rest[rest.indexOf('--bin') + 1];
      if (!rest.includes('--bin') || !bin?.startsWith('/') || !root.startsWith('/')) throw new Error('Absolute --bin and --root paths required');
      const { driveMacJobs } = await import('../core/drive/mac-jobs.js');
      console.log(JSON.stringify(driveMacJobs(bin, root), null, 2));
      return 0;
    }
    const [statusText, jobsText] = await Promise.all([
      readFile(join(root, 'status.json'), 'utf8'), readFile(join(root, 'jobs.jsonl'), 'utf8'),
    ]);
    const { status, jobs } = parseDriveInputs(statusText, jobsText);
    const report = buildDriveReport(status, jobs);
    const { buildFleetDigest } = await import('../core/fleet/digest.js');
    const fleet = await buildFleetDigest('7d');
    const output = { ...report, fleet };
    await mkdir(root, { recursive: true });
    const temporary = join(root, `.relay-status-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(output, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(root, 'relay-status.json'));
    } finally {
      await rm(temporary, { force: true });
    }
    console.log(rest.includes('--json') ? JSON.stringify(output) : `Drive status written: ${report.health.length} health findings, ${report.levers.length} levers, ${report.prLinks.length} PR links`);
    return 0;
  } catch {
    // Do not echo journal contents or paths from untrusted inputs.
    console.error('Drive snapshot unavailable or invalid; relay status was not refreshed');
    return 1;
  }
}

export async function cmdMetrics(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('phm metrics [--root <directory>] [--json]');
    return 0;
  }
  const invalid = rejectUnknownOptions(args, { flags: ['--json'], values: ['--root'] });
  if (invalid || args.some((token, i) => !token.startsWith('-') && args[i - 1] !== '--root')) {
    console.error(invalid?.message ?? 'Invalid metrics arguments');
    return 2;
  }
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1]! : join(homedir(), '.ashlr', 'drive');
  try {
    const [statusText, jobsText] = await Promise.all([
      readFile(join(root, 'status.json'), 'utf8'), readFile(join(root, 'jobs.jsonl'), 'utf8'),
    ]);
    const { status, jobs } = parseDriveInputs(statusText, jobsText);
    const { levers } = buildDriveReport(status, jobs);
    console.log(args.includes('--json') ? JSON.stringify({ levers }) :
      levers.map((lever, i) => `${i + 1}. ${lever.action} (${lever.count})`).join('\n') || 'No actionable levers');
    return 0;
  } catch {
    console.error('Metrics snapshot unavailable or invalid');
    return 1;
  }
}
