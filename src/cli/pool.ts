import { readAdmission, type AdmissionReport, type ReadAdmissionOptions } from '../core/queue/admission.js';

const HELP = `Usage: phm pool admission [--json]

admission: what dispatchd would decide about new claims right now, read-only.
  JSON includes per-lane routine/critical usage pacing verdicts and reasons.
  Reports 1-min loadavg, ncpu, the global running cap, running jobs, the install-lock
  holder and admit true/false with the reason. Exit 0 either way; 2 on bad arguments.
  No claims while loadavg > min(2 x ncpu, 36), processes > 800, live job worktrees > 40,
  or the ashlr daemon's lastTickAt is more than 15 minutes old (or unreadable).
  Cap = min(sum of unheld lane targets, ncpu, hard_cap in queue/slots.json).
  At most one npm ci / pnpm install / bun install runs fleet-wide (queue/install.lock).
  The runs directory is ASHLR_RUNS_DIR or ~/.ashlr-runs; queue/LOADGATE_OFF disables the gate.`;

function render(r: AdmissionReport): string {
  const holder = r.installLock.holder;
  return [
    `admit=${r.admit}${r.reason ? ` reason=${r.reason}` : ''}${r.disabled ? ' (gate disabled by queue/LOADGATE_OFF)' : ''}`,
    `load1=${r.load.load1.toFixed(2)} max=${r.load.max.toFixed(1)} ncpu=${r.ncpu} procs=${r.procs} worktrees=${r.worktrees}`,
    `running=${r.running} cap=${r.cap} hard_cap=${r.hardCap}`,
    `daemon tick age=${r.daemon.tickAgeSeconds === null ? 'unknown' : `${Math.floor(r.daemon.tickAgeSeconds)}s`}`,
    `install lock holder=${holder ? `pid ${holder.pid}${holder.job ? ` job ${holder.job}` : ''}${holder.command ? ` (${holder.command})` : ''}` : 'none'}`,
  ].join('\n');
}

export async function cmdPool(args: string[], deps: ReadAdmissionOptions = {}): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') { console.log(HELP); return 0; }
  const rest = args.slice(1);
  if (args[0] !== 'admission' || rest.some(a => a !== '--json' && a !== '--help' && a !== '-h') || new Set(rest).size !== rest.length) {
    console.error(HELP); return 2;
  }
  if (rest.includes('--help') || rest.includes('-h')) { console.log(HELP); return 0; }
  const report = await readAdmission(deps);
  // Infinity (unreadable process table) has no JSON form; report it as null alongside the reason.
  if (rest.includes('--json')) console.log(JSON.stringify(report, (_k, v) => typeof v === 'number' && !Number.isFinite(v) ? null : v));
  else console.log(render(report));
  return 0;
}
