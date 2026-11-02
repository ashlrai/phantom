/**
 * `ashlr fleet self-tick-schedule` — install the host timer that runs
 * `fleet self-tick` (RQ-PHX-SELFTICKSCHEDULE02). The tick verb already runs
 * reset-release, lane-autohold and planner-tick as one locked pass "for a
 * host timer", but nothing installed that timer: this verb writes the per-user
 * launchd agent (macOS, RunAtLoad + StartInterval) or systemd user service and
 * timer (Linux, OnBootSec + OnUnitActiveSec) modelled on `phm steward
 * schedule`. Preview by default; `--write` installs atomically (tmp + rename,
 * identical contents skipped), `--load` bootstraps/enables it through an
 * argv-only spawn seam, `--tick-apply` lets the scheduled tick pass --apply.
 * On macOS `--load` probes `launchctl print gui/<uid>/<label>` first: a label
 * that is already loaded with an unchanged plist is reported already-loaded
 * instead of being bootstrapped again (which launchd refuses), while a changed
 * plist exits nonzero saying a reload is required. It never unloads or removes
 * any other launchd label or systemd unit — and never unloads its own.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  selfTickSchedule,
  SELF_TICK_LABEL,
  SELF_TICK_MAX_INTERVAL_SECONDS,
  SELF_TICK_MIN_INTERVAL_SECONDS,
} from '../core/fleet/self-tick-schedule.js';
import type { ScheduleUnit } from '../core/steward/schedule.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet self-tick-schedule [--json] [--write] [--load] [--tick-apply] [--interval <s>] [--runs-dir <abs>] [--ashlr-path <abs>] [--node-path <abs>]
Preview (default) or install the per-user timer that runs 'fleet self-tick'
every interval and at boot/login. --write writes the unit files atomically and
reports each path as written or unchanged (identical contents are skipped);
without it nothing is written. --load is only valid with --write and runs each
unit's activation argv (launchctl bootstrap / systemctl --user enable) — never
a shell string; on macOS an already-loaded label whose plist is unchanged is
reported already-loaded without re-bootstrapping, and a changed plist while
loaded reports that a reload is required and exits nonzero. The scheduled tick
is a dry run unless --tick-apply is given.
--interval is 300..3600 seconds (default 900); --runs-dir pins the runs dir the
tick uses. --ashlr-path is the installed Phantom script the timer runs (default:
this running CLI's script); --node-path is the Node runtime it runs under
(default: this running Node). Both must be absolute, control-free and may name
paths that do not exist on this machine, so a standby host can be prepared from
a planner. The JSON preview reports the effective ashlrPath and nodePath. This
verb never unloads or removes any other service. Exit 0 on success, 1 on
failure, 2 on usage.`;

interface Dependencies {
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Activation seam for --load: one argv array per call, never a shell. */
  spawn?: (argv: readonly string[]) => { status: number | null; error?: Error };
  home?: string;
  platform?: NodeJS.Platform;
}

type UnitState = 'preview' | 'written' | 'unchanged';
type ActivationState = 'activated' | 'already-loaded';

/** Absolute and control-free, checked before any write; the path need not exist here. */
function absolutePathArg(value: string | undefined): string | undefined {
  if (value === undefined || !isAbsolute(value)) return undefined;
  return [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ? undefined : value;
}

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

/** Atomic install: tmp file + rename; identical contents are left alone. */
function writeUnit(unit: ScheduleUnit, home: string): Exclude<UnitState, 'preview'> {
  if (existsSync(unit.path) && readFileSync(unit.path, 'utf8') === unit.contents) return 'unchanged';
  scheduleDirectory(dirname(unit.path), home);
  const tmp = join(dirname(unit.path), `.${basename(unit.path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, unit.contents, { mode: 0o600 });
    renameSync(tmp, unit.path);
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed away or never written */ }
  }
  return 'written';
}

export async function cmdFleetSelfTickSchedule(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  let json = false, write = false, load = false, tickApply = false;
  let intervalSeconds: number | undefined, runsDir: string | undefined;
  let ashlrPath: string | undefined, nodePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--write' && !write) write = true;
    else if (arg === '--load' && !load) load = true;
    else if (arg === '--tick-apply' && !tickApply) tickApply = true;
    else if (arg === '--interval' && intervalSeconds === undefined) {
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) return invalid();
      intervalSeconds = Number(value);
      if (intervalSeconds < SELF_TICK_MIN_INTERVAL_SECONDS || intervalSeconds > SELF_TICK_MAX_INTERVAL_SECONDS) return invalid();
    } else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else if (arg === '--ashlr-path' && ashlrPath === undefined) {
      const value = absolutePathArg(args[++i]);
      if (value === undefined) return invalid();
      ashlrPath = value;
    } else if (arg === '--node-path' && nodePath === undefined) {
      const value = absolutePathArg(args[++i]);
      if (value === undefined) return invalid();
      nodePath = value;
    } else return invalid();
  }
  if (load && !write) return invalid();
  const home = deps.home ?? homedir();
  // Defaults: this running CLI's own script (never a PATH lookup) and this Node.
  const effectiveAshlrPath = ashlrPath ?? resolve(process.argv[1] ?? process.execPath);
  const effectiveNodePath = nodePath ?? process.execPath;
  let units: ScheduleUnit[];
  try {
    units = selfTickSchedule({
      ashlrPath: effectiveAshlrPath,
      nodePath: effectiveNodePath,
      apply: tickApply,
      ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
      ...(runsDir === undefined ? {} : { runsDir }),
      platform: deps.platform,
      home,
    });
  } catch (err) {
    error(`error: ${(err as Error).message}`);
    return 1;
  }
  const report: { path: string; state: UnitState; activate: readonly string[]; activation?: ActivationState }[] = [];
  if (write) {
    try {
      if (process.getuid?.() === 0) throw new Error('Install the self-tick timer as a regular user, not root.');
      for (const unit of units) report.push({ path: unit.path, state: writeUnit(unit, home), activate: unit.activate });
      scheduleDirectory(join(home, '.ashlr', 'logs'), home);
    } catch (err) {
      error(`error: ${(err as Error).message}`);
      return 1;
    }
  } else {
    for (const unit of units) report.push({ path: unit.path, state: 'preview', activate: unit.activate });
  }
  if (load) {
    const spawn = deps.spawn ?? ((argv: readonly string[]) =>
      spawnSync(argv[0]!, argv.slice(1), {
        // A `launchctl print` probe dumps the whole service record on stdout;
        // keep that off the console while its stderr diagnostics stay visible.
        stdio: argv[0] === 'launchctl' && argv[1] === 'print' ? ['ignore', 'ignore', 'inherit'] : 'inherit',
        timeout: 30_000,
        shell: false,
      }));
    for (const unit of report) {
      if (!unit.activate.length) continue;
      const [tool, verb, domain] = unit.activate;
      if (tool === 'launchctl' && verb === 'bootstrap' && domain !== undefined) {
        // launchd refuses a second bootstrap for an already-loaded label, so a
        // repeated install must probe this exact label in the bootstrap's own
        // gui domain before activating. Loaded + unchanged means the install
        // is already done; loaded + changed must be reported as needing a
        // reload, never silently claimed as active. Any other probe outcome
        // falls through to a real bootstrap whose failure still propagates.
        const target = `${domain}/${SELF_TICK_LABEL}`;
        const probe = spawn(['launchctl', 'print', target]);
        if (!probe.error && probe.status === 0) {
          if (unit.state === 'unchanged') {
            unit.activation = 'already-loaded';
            continue;
          }
          error(`${unit.path} changed while ${target} is already loaded: a reload is required for the new definition to take effect. This verb never unloads or restarts services — run launchctl bootout ${target} and re-run this command to activate the new definition.`);
          return 1;
        }
      }
      const result = spawn(unit.activate);
      if (result.error || result.status !== 0) {
        error(`Activation failed for ${unit.path}. Run this command manually: ${JSON.stringify(unit.activate)}`);
        return 1;
      }
      unit.activation = 'activated';
    }
  }
  if (json) {
    output(JSON.stringify(sanitizePublicJson({
      v: 1,
      apply: tickApply,
      ashlrPath: effectiveAshlrPath,
      nodePath: effectiveNodePath,
      intervalSeconds: intervalSeconds ?? 900,
      write,
      loaded: load,
      units: report,
    })));
  } else {
    const lines = [`fleet self-tick-schedule: ${write ? (load ? 'INSTALLED + LOADED' : 'INSTALLED') : 'PREVIEW — nothing written'}${tickApply ? ' (tick applies changes)' : ' (tick is a dry run)'}`];
    for (const unit of report) {
      lines.push(`  ${unit.path}  ${unit.state}`);
      lines.push(`    activate: ${JSON.stringify(unit.activate)}`);
      if (unit.activation) lines.push(`    activation: ${unit.activation}`);
    }
    if (!write) lines.push('Re-run with --write to install the unit files; add --load to activate the timer.');
    output(lines.join('\n'));
  }
  return 0;
}
