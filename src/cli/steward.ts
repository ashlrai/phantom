/** `phm steward` — disk/log guardrails for agent CLIs (dry run by default). */
import { defaultStewardPolicy, runSteward } from '../core/steward/disk.js';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stewardSchedule } from '../core/steward/schedule.js';

const USAGE = 'Usage: phm steward disk [--apply] [--json] | phm steward schedule [--install] [--apply] [--hour 0-23]';
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

/** Create only real directories below HOME; never follow a linked config root. */
function scheduleDirectory(path: string, home: string): void {
  const root = lstatSync(home);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Refusing linked HOME.');
  let current = home;
  for (const part of relative(home, path).split('/')) {
    if (part === '..') throw new Error('Schedule directory must be inside HOME.');
    current = join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing linked schedule directory: ${current}`);
  }
}

function schedule(argv: string[]): number {
  let hour: number | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!['--hour', '--install', '--apply'].includes(arg) || flags.has(arg)) {
      console.error(`error: unknown or repeated argument: ${arg}\n${USAGE}`); return 2;
    }
    flags.add(arg);
    if (arg === '--hour') {
      const value = argv[++i];
      if (value === undefined || !/^\d{1,2}$/.test(value) || Number(value) > 23) {
        console.error('error: --hour requires an integer from 0 to 23'); return 2;
      }
      hour = Number(value);
    }
  }
  try {
    // Resolve the packaged shim from src/ or dist/, never the tsx argv entry.
    const phmPath = fileURLToPath(new URL('../../bin/ashlr', import.meta.url));
    const units = stewardSchedule({ phmPath, apply: flags.has('--apply'), hour });
    if (!flags.has('--install')) {
      for (const unit of units) console.log(`# ${unit.path}\n${unit.contents}`);
      console.log('Re-run with --install to enable (report-only unless --apply).'); return 0;
    }
    if (process.getuid?.() === 0) throw new Error('Install the steward as a regular user, not root.');
    if (!existsSync(fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url)))) {
      throw new Error('Compiled CLI missing; run npm run build before installing the schedule.');
    }
    const home = homedir();
    const created: string[] = [];
    try {
      for (const unit of units) {
        scheduleDirectory(dirname(unit.path), home);
        // Exclusive create also refuses symlinks and preserves existing jobs.
        const fd = openSync(unit.path, 'wx', 0o600);
        created.push(unit.path);
        try { writeFileSync(fd, unit.contents); } finally { closeSync(fd); }
      }
      scheduleDirectory(join(home, '.ashlr', 'logs'), home);
      const log = join(home, '.ashlr', 'logs', 'steward.jsonl');
      try { closeSync(openSync(log, 'wx', 0o600)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = lstatSync(log);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Refusing linked steward log.');
      }
    } catch (error) {
      for (const path of created) unlinkSync(path);
      throw error;
    }
    for (const unit of units) {
      if (!unit.activate.length) continue;
      const result = spawnSync(unit.activate[0]!, unit.activate.slice(1), { stdio: 'inherit', timeout: 30_000 });
      if (result.error || result.status !== 0) {
        console.error('Schedule files written, but activation failed. Run these commands manually:');
        for (const pending of units) console.error(JSON.stringify(pending.activate));
        return 1;
      }
    }
    console.log(`Steward scheduled daily (${flags.has('--apply') ? 'apply' : 'report-only'}).`);
    return 0;
  } catch (error) { console.error(`error: ${(error as Error).message}`); return 1; }
}

export async function cmdSteward(argv: string[]): Promise<number> {
  // --help anywhere prints usage without scanning: `disk --apply --help` used
  // to delete files, and unknown flags (a typo'd --aply) ran a silent dry run.
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') { console.log(USAGE); return 0; }
  const [sub = 'disk', ...rest] = argv;
  if (sub === 'schedule') return schedule(rest);
  if (sub !== 'disk') { console.error(USAGE); return 2; }
  const unknown = rest.find((a) => a !== '--apply' && a !== '--json');
  if (unknown !== undefined) { console.error(`error: unknown argument: ${unknown}\n${USAGE}`); return 2; }
  const report = runSteward(defaultStewardPolicy(), { apply: rest.includes('--apply') });
  if (rest.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return 0; }
  for (const r of report.roots) {
    if (!r.exists) continue;
    console.log(`${r.overQuota ? '!' : ' '} ${r.id.padEnd(16)} ${mb(r.bytes).padStart(10)} / ${mb(r.quotaBytes)}  ${r.action} ${mb(r.reclaimable.bytes)} (${r.reclaimable.files} files)`);
    if (r.overQuota && r.nativeHint) console.log(`    hint: ${r.nativeHint}`);
  }
  console.log(report.applied ? `Deleted ${report.deleted.files} files (${mb(report.deleted.bytes)}); archived ${report.archived.files} cold sessions (${mb(report.archived.bytes)}) to ~/.ashlr/archive.` : `Dry run: ${mb(report.reclaimableBytes)} reclaimable. Re-run with --apply (logs are deleted; Codex/Claude sessions are gzip-archived, never hand-deleted; active sessions untouched).`);
  return 0;
}
