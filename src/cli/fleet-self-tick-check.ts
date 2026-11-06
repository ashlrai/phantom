/**
 * `ashlr fleet self-tick-check` — read-only machine verdict on whether the
 * scheduled self-tick timer is installed and confirmed active by this user's
 * service manager (RQ-PHX-SCHEDULECHECKACTION02SOLB2). An agent can branch on
 * the exit code and invoke the printed installer argv when the timer is
 * absent instead of trusting queued state. It only stats the canonical unit
 * paths and runs bounded argv-only probes (launchctl print on macOS,
 * systemctl --user is-enabled/is-active on Linux); it never installs, loads,
 * unloads, spawns or writes, and never prints unit contents or raw manager
 * output.
 */
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { checkSelfTickSchedule, type SelfTickCheckProbe, type SelfTickCheckReport } from '../core/fleet/self-tick-check.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet self-tick-check [--json] [--runs-dir <abs>]
Read-only verdict: is the per-user self-tick timer installed and confirmed
active by this user's service manager? Stats the canonical unit paths and
probes launchctl print gui/<uid>/<label> (macOS) or systemctl --user
is-enabled + is-active phm-self-tick.timer (Linux) — argv-only, bounded,
never a shell; never installs, loads, unloads or writes. --runs-dir adds the
last recorded run's freshness, reported separately and never called healthy
work. missing/inactive suggests (never runs) the fixed installer argv 'ashlr
fleet self-tick-schedule --write --load'. Exit 0 installed+confirmed active,
1 missing/inactive, 2 usage, 3 unknown/unreadable/unsupported.`;

interface Dependencies {
  output?: (text: string) => void; error?: (text: string) => void;
  home?: string; platform?: NodeJS.Platform; uid?: number; now?: () => number;
  probe?: SelfTickCheckProbe; // service-manager seam; tests fake it, never a shell
}

const defaultProbe: SelfTickCheckProbe = (argv) => {
  try {
    const r = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 15_000 });
    return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
};

const reason = (r: SelfTickCheckReport): string =>
  !r.supported ? `unsupported platform ${r.platform}`
  : r.units.some((u) => u.state === 'unreadable') ? 'unit path unreadable'
  : r.manager?.state === 'probe-failed' ? `service-manager probe failed (${r.manager.detail ?? 'unclassified'})`
  : r.verdict === 'active' ? `${r.manager?.tool ?? 'service manager'} confirms the timer`
  : r.verdict === 'missing' ? 'timer definition absent'
  : 'installed but not confirmed active';

function human(report: SelfTickCheckReport): string {
  const lines = [
    `fleet self-tick-check: ${report.verdict.toUpperCase()} — ${reason(report)}`,
    ...report.units.map((u) => `  unit ${u.state}: ${u.path}`),
  ];
  if (report.manager) lines.push(`  manager: ${report.manager.state}`);
  const last = report.lastRun;
  if (last !== null) {
    const detail = last.state === 'fresh' || last.state === 'stale'
      ? `${last.at} (${Math.floor(last.ageSeconds / 60)}m ago) `
        + `${last.state === 'stale' ? 'STALE — not healthy work' : 'fresh'} `
        + `mode=${last.mode} failed=${last.failedSteps.join(',') || 'none'}`
      : last.state === 'missing' ? 'none recorded — the timer has left no trace' : 'record unreadable';
    lines.push(`  last run: ${detail}`);
  }
  if (report.suggestedInstall) lines.push(`  install: ${report.suggestedInstall.join(' ')}`);
  return lines.join('\n');
}

export async function cmdFleetSelfTickCheck(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  let json = false, runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else return invalid();
  }
  const report = checkSelfTickSchedule({
    probe: deps.probe ?? defaultProbe,
    home: deps.home, platform: deps.platform, uid: deps.uid, runsDir,
    ...(deps.now === undefined ? {} : { now: deps.now() }),
  });
  output(json ? JSON.stringify(sanitizePublicJson(report)) : human(report));
  return report.exitCode;
}
