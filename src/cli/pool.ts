import { readAdmission, type AdmissionReport, type ReadAdmissionOptions } from '../core/queue/admission.js';
import type { PoolRunway, RunwaySnapshot } from '../core/usage/runway.js';

const HELP = `Usage: phm pool runway [--json]
       phm pool admission [--json]
       phm pool why <pool> [--json]

runway: will each pool last until it resets, at the burn rate measured now?
  One sentence, then one line per pool: state, used, burn per hour, hours to empty,
  hours to reset and what to do. States: starve (runs dry before reset; frontier and
  high-yield work only), spend (resets with usage left; send filler here), pace (on track)
  and unknown (a reading is missing; never guessed). Starving pools come first. Read-only.
  --json prints pool.runway.v1 {schema,v,asOf,headline,pools:[{pool,state,usedPercent,burnPerHour,
  hoursToEmpty,hoursToReset,idleHours,unusedAtResetPercent,safeBurnPerHour,reason,advice}]}.
  Reads queue/status.json under ASHLR_RUNS_DIR or ~/.ashlr-runs.

admission: what dispatchd would decide about new claims right now, read-only.
  JSON includes per-lane routine/critical usage pacing verdicts and reasons.
  Adaptive settle is advisory until integrated into the pinned host guard; phm admission explain shows its inputs.
  Reports 1-min loadavg, ncpu, the global running cap, running jobs, the install-lock
  holder and admit true/false with the reason. Exit 0 either way; 2 on bad arguments.
  Updated hosts report the dispatcher's admission.v2 snapshot, including its timestamp,
  starvation signals, warnings and claim limit. Memory pressure at warn or above, rapid swap growth
  or low disk stop claims, as does load1 over 2 x ncpu. Older hosts use legacy probes, as
  does a snapshot without a timestamp or older than 15 minutes (reported as stale).
  Cap = min(sum of unheld lane targets, adaptive cap, optional hard_cap in queue/slots.json).
  The adaptive cap (queue/concurrency.json) rises on headroom and backs off on pressure;
  hosts without it fall back to ncpu.
  At most one npm ci / pnpm install / bun install runs fleet-wide (queue/install.lock).
  The runs directory is ASHLR_RUNS_DIR or ~/.ashlr-runs. queue/LOADGATE_OFF no longer disables the gate.`;

function render(r: AdmissionReport): string {
  const holder = r.installLock.holder;
  return [
    `admit=${r.admit}${r.reason ? ` reason=${r.reason}` : ''}${r.disabled ? ' (gate disabled by queue/LOADGATE_OFF)' : ''}`,
    `load1=${r.load.load1.toFixed(2)} max=${r.load.max.toFixed(1)} ncpu=${r.ncpu} procs=${r.procs} worktrees=${r.worktrees}`,
    `running=${r.running} cap=${r.cap} adaptive_cap=${r.adaptiveCap ?? 'none'} hard_cap=${r.hardCap ?? 'none'}`,
    `settle=${r.settle.settleSeconds}s (advisory): ${r.settle.reason}`,
    `daemon tick age=${r.daemon.tickAgeSeconds === null ? 'unknown' : `${Math.floor(r.daemon.tickAgeSeconds)}s`}`,
    ...(r.staleSnapshot ? [`dispatchd snapshot stale (ts=${r.staleSnapshot.ts ?? 'missing'}${r.staleSnapshot.ageSeconds === null ? '' : `, age=${Math.floor(r.staleSnapshot.ageSeconds)}s`}); live probes shown`] : []),
    `install lock holder=${holder ? `pid ${holder.pid}${holder.job ? ` job ${holder.job}` : ''}${holder.command ? ` (${holder.command})` : ''}` : 'none'}`,
  ].join('\n');
}

const shown = (n: number | null, unit: string): string => n === null ? 'unknown' : `${Math.round(n * 100) / 100}${unit}`;

/** One plain line per pool: state, the four numbers behind it, then the advice. */
export function runwayLine(row: PoolRunway): string {
  const empty = row.hoursToEmpty === null && row.state !== 'unknown' && row.burnPerHour === 0 ? 'never at this rate' : shown(row.hoursToEmpty, 'h');
  return `${row.pool}: ${row.state.toUpperCase()} · ${shown(row.usedPercent, '%')} used · burn ${shown(row.burnPerHour, '%/h')}`
    + ` · empty in ${empty} · reset in ${shown(row.hoursToReset, 'h')} · ${row.advice}`;
}

export interface PoolDeps extends ReadAdmissionOptions { readRunway?: () => Promise<RunwaySnapshot>; readPace?: () => Promise<import('../core/fleet/pace-verdict.js').FleetPaceV1> }

export async function cmdPool(args: string[], deps: PoolDeps = {}): Promise<number> {
  if (args[0] === 'why') return (await import('./pool-why.js')).cmdPoolWhy(args.slice(1), deps.readPace);
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') { console.log(HELP); return 0; }
  const rest = args.slice(1);
  if (!['admission', 'runway'].includes(args[0] ?? '') || rest.some(a => a !== '--json' && a !== '--help' && a !== '-h') || new Set(rest).size !== rest.length) {
    console.error(HELP); return 2;
  }
  if (rest.includes('--help') || rest.includes('-h')) { console.log(HELP); return 0; }
  if (args[0] === 'runway') {
    const snapshot = await (deps.readRunway ?? (async () => (await import('../core/usage/runway-read.js')).readPoolRunway()))();
    if (rest.includes('--json')) console.log(JSON.stringify(snapshot, null, 2));
    else for (const line of [snapshot.headline, ...snapshot.pools.map(runwayLine)]) console.log(line);
    return 0;
  }
  const report = await readAdmission(deps);
  // Infinity (unreadable process table) has no JSON form; report it as null alongside the reason.
  if (rest.includes('--json')) console.log(JSON.stringify(report, (_k, v) => typeof v === 'number' && !Number.isFinite(v) ? null : v));
  else console.log(render(report));
  return 0;
}
