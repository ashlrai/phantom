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
 *
 * `--record-only` switches the verdict to the recorded run itself
 * (RQ-PHX-SELFTICKCHECK02SOLC2): the same queue/self-tick-last.json record
 * the timer's own write left, judged for a host supervisor that must prove
 * the timer actually ran and succeeded — exit 0 only for a readable, fresh,
 * ran record with no failed steps (and an apply pass under --require-apply).
 * No service-manager probe runs, so it works on every platform.
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  checkSelfTickRecord,
  checkSelfTickSchedule,
  SELF_TICK_LAST_STALE_SECONDS,
  SELF_TICK_RECORD_MAX_AGE_DEFAULT_SECONDS,
  type SelfTickCheckProbe,
  type SelfTickCheckReport,
  type SelfTickRecordCheck,
} from '../core/fleet/self-tick-check.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet self-tick-check [--json] [--runs-dir <abs>] [--max-age-seconds <n>] [--record-only] [--require-apply]
Read-only verdict: is the per-user self-tick timer installed and confirmed
active by this user's service manager? Stats the canonical unit paths and
probes launchctl print gui/<uid>/<label> (macOS) or systemctl --user
is-enabled + is-active phm-self-tick.timer (Linux) — argv-only, bounded,
never a shell; never installs, loads, unloads or writes. --runs-dir adds the
last recorded run's freshness, reported separately and never called healthy
work; --max-age-seconds tunes that freshness bound (default
${SELF_TICK_LAST_STALE_SECONDS}s). missing/inactive suggests (never runs)
the fixed installer argv 'ashlr fleet self-tick-schedule --write --load'.
Exit 0 installed+confirmed active, 1 missing/inactive, 2 usage, 3
unknown/unreadable/unsupported.

--record-only judges only the recorded run (queue/self-tick-last.json under
--runs-dir, ASHLR_RUNS_DIR or ~/.ashlr-runs): exit 0 only for a readable,
fresh (within --max-age-seconds, default ${SELF_TICK_RECORD_MAX_AGE_DEFAULT_SECONDS}),
ran record with no failed steps — and an apply pass under --require-apply.
Reasons: ok, missing, unreadable, future, stale, busy, failed, dry-run.
No probe runs; every platform is supported. Exit 0 healthy, 1 unhealthy,
2 usage.`;

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

function humanRecord(report: SelfTickRecordCheck): string {
  return `fleet self-tick-check: ${report.healthy ? 'healthy' : 'UNHEALTHY'} `
    + `(${report.reason === 'ok' ? '' : `reason=${report.reason} `}${report.detail})`;
}

/** --json payload for the record verdict: the PR-stable field set plus exitCode. */
function recordJson(report: SelfTickRecordCheck): Record<string, unknown> {
  const { detail: _detail, exitCode, ...rest } = report;
  return { ...rest, exitCode };
}

export async function cmdFleetSelfTickCheck(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  let json = false, recordOnly = false, requireApply = false;
  let runsDir: string | undefined, maxAgeSeconds: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--record-only' && !recordOnly) recordOnly = true;
    else if (arg === '--require-apply') {
      if (requireApply) return invalid();
      requireApply = true;
    }
    else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else if (arg === '--max-age-seconds' && maxAgeSeconds === undefined) {
      const value = args[++i];
      const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 1) return invalid();
      maxAgeSeconds = parsed;
    } else return invalid();
  }
  // --require-apply only has meaning for the record verdict; refusing it in
  // the default mode keeps a mistyped flag from being silently ignored.
  if (requireApply && !recordOnly) return invalid();

  const nowMs = (deps.now ?? Date.now)();
  if (recordOnly) {
    // Same runs-root fallback as self-tick itself: --runs-dir, then
    // ASHLR_RUNS_DIR, then ~/.ashlr-runs. Only the last-run record is read.
    const home = deps.home ?? homedir();
    const root = resolve(runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(home, '.ashlr-runs'));
    const report = checkSelfTickRecord({
      runsDir: root, now: nowMs,
      ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
      requireApply,
    });
    output(json
      ? JSON.stringify(sanitizePublicJson(recordJson(report)))
      : humanRecord(report));
    return report.exitCode;
  }

  const report = checkSelfTickSchedule({
    probe: deps.probe ?? defaultProbe,
    home: deps.home, platform: deps.platform, uid: deps.uid,
    now: nowMs, runsDir,
    ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
  });
  output(json ? JSON.stringify(sanitizePublicJson(report)) : human(report));
  return report.exitCode;
}
