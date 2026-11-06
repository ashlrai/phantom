/**
 * `ashlr fleet self-tick` — one locked pass of Phantom's self-management for
 * a host timer or an agent with no desktop app open. It calls the six
 * existing one-shot verbs in the fixed order reset-release → lane-autohold
 * → planner-tick → inbox-acks → order-notices → landed-sweep, each with --json (plus --apply and --runs-dir when given),
 * and folds their parsed reports into one run report. Only one self-tick runs
 * per runs dir; a step that fails or throws never stops the later ones.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { cmdFleetResetRelease } from './fleet-reset-release.js';
import { cmdFleetLaneAutohold } from './fleet-lane-autohold.js';
import { cmdFleetPlannerTick } from './fleet-planner-tick.js';
import { cmdFleetInboxAcks, type FleetInboxAcksDeps } from './fleet-inbox-acks.js';
import { cmdFleetOrderNotices, type FleetOrderNoticesDeps } from './fleet-order-notices.js';
import { cmdFleetLandedSweep } from './fleet-landed-sweep.js';
import type { SpawnLike } from '../core/fleet/planner-run.js';
import { runSelfTick, type RunSelfTickOptions, type SelfTickStep, type SelfTickSteps } from '../core/fleet/self-tick.js';
import { readSelfTickLast } from '../core/fleet/self-tick-last.js';
import { capSelfTickLog, selfTickLogPath } from '../core/fleet/self-tick-log-cap.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet self-tick [--json] [--runs-dir <abs>] [--apply] [--last]
One locked pass of Phantom's self-management: reset-release first (a lane it
frees counts as a free slot for the planner step), then lane-autohold, then
planner-tick, then inbox-acks (sends pending same-channel acks), then order-notices
(tells Mason when a merged job served one of his orders), then landed-sweep (closes DIRTY PRs whose work already landed;
last because it is the slowest). Without --apply nothing is released, held, spawned, acknowledged or notified — the
planner step still appends its observational PLANNER_TICK line to
queue/dispatch-events.log either way. Only one self-tick runs per runs dir:
a held queue/self-tick.lock reports 'busy' and exits 0. A step that fails or
throws never stops the later ones. Each completed pass records itself to
queue/self-tick-last.json while the lock is still held; --last prints that
recorded run (or 'no recorded run') without running a step or taking the
lock, combines only with --json and --runs-dir, and exits 0 even when
nothing is recorded. Exit 0 when every step is ok or the run is busy, 1
when any step failed, 2 on usage.`;

interface Dependencies {
  now?: () => number;
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Per-step overrides for tests; unlisted steps run the real verbs. */
  steps?: Partial<SelfTickSteps>;
  /** Lock seam forwarded to runSelfTick. */
  acquireLock?: RunSelfTickOptions['acquireLock'];
  /** planner-tick spawn seam; tests fake it, never a shell. */
  spawn?: SpawnLike;
  /** Home override for tests; the runs-dir fallback and the log cap use it. */
  home?: string;
  /** Inbox acknowledgement senders for tests; production defaults are unchanged. */
  senders?: FleetInboxAcksDeps['senders'];
  /** Order-merge notice senders for tests; production defaults are unchanged. */
  noticeSenders?: FleetOrderNoticesDeps['senders'];
}

/** The escaped, home-scrubbed spelling of one value for human output. */
const safe = (value: unknown): string => JSON.stringify(sanitizePublicJson(value))
  .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** A short per-step summary for human output, read defensively. */
function summary(step: string, report: unknown): string {
  if (typeof report !== 'object' || report === null) return '';
  const row = report as Record<string, unknown>;
  const count = (value: unknown): number => Array.isArray(value) ? value.length : 0;
  if (step === 'reset-release') {
    return `released=${count(row['released'])} planned=${count(row['planned'])}`;
  }
  if (step === 'lane-autohold') {
    const decisions = Array.isArray(row['decisions']) ? row['decisions'] : [];
    const held = decisions.filter((d) => (d as Record<string, unknown>)['result'] === 'held').length;
    return `held=${held} decisions=${decisions.length}`;
  }
  if (step === 'inbox-acks') {
    const totals = row['totals'] as Record<string, unknown> | undefined;
    const n = (value: unknown): number => typeof value === 'number' ? value : 0;
    return `acked=${n(totals?.['acked'])} pending=${n(totals?.['pending'])}`;
  }
  if (step === 'order-notices') {
    const n = (value: unknown): number => typeof value === 'number' ? value : 0;
    return `sent=${n(row['sent'])} planned=${count(row['notices'])}`;
  }
  if (step === 'landed-sweep') {
    const n = (value: unknown): number => typeof value === 'number' ? value : 0;
    return `closed=${n(row['closed'])} planned=${n(row['planned'])}`;
  }
  const reason = row['reason'] ?? row['outcome'];
  return typeof reason === 'string' ? reason : '';
}

export async function cmdFleetSelfTick(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  let json = false, apply = false, last = false, runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--last' && !last) last = true;
    else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else return invalid();
  }
  // --last is a read-only report of the last recorded pass: nothing runs,
  // no lock is taken, so --apply has no meaning beside it.
  if (last && apply) return invalid();
  // One root for the lock and all six steps: the verbs' own fallbacks
  // (ASHLR_RUNS_DIR, ~/.ashlr-runs) resolve here once, so the lock domain
  // and the released slots can never drift to different dirs.
  const home = deps.home ?? homedir();
  const root = resolve(runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(home, '.ashlr-runs'));
  const now = deps.now ?? Date.now;
  if (last) {
    const view = readSelfTickLast(root, now());
    if (json) {
      output(JSON.stringify(sanitizePublicJson(view)));
    } else if (view === null) {
      output('no recorded run');
    } else if (view.state === 'unreadable') {
      output('fleet self-tick: last run unreadable');
    } else {
      const failed = view.failedSteps.length > 0 ? view.failedSteps.join(',') : 'none';
      output(`fleet self-tick: last run ${view.at} (${Math.floor(view.ageSeconds / 60)}m ago) ${view.mode} failed=${failed}`);
    }
    return 0;
  }
  // The scheduled log grows without bound (every tick appends each step's
  // full JSON report); cap it in place before this run adds to it. Runs
  // once per real run — never on --last — and never throws.
  const logCap = capSelfTickLog(selfTickLogPath(home));
  const bind = (
    run: (argv: string[], io: { output: (text: string) => void; error: (text: string) => void }) => Promise<number>,
    extra: Record<string, unknown> = {},
  ): SelfTickStep => async (argv) => {
    const captured: string[] = [];
    const exitCode = await run(argv, {
      ...extra,
      output: (text) => captured.push(text),
      error,
    });
    return { exitCode, output: captured.join('\n') };
  };
  const defaults: SelfTickSteps = {
    'reset-release': bind(cmdFleetResetRelease, { now }),
    'lane-autohold': bind(cmdFleetLaneAutohold, { now: () => new Date(now()) }),
    'planner-tick': bind(cmdFleetPlannerTick, { now, spawn: deps.spawn }),
    'inbox-acks': bind(cmdFleetInboxAcks, { now: () => new Date(now()), senders: deps.senders }),
    'order-notices': bind(cmdFleetOrderNotices, { now, senders: deps.noticeSenders }),
    'landed-sweep': bind(cmdFleetLandedSweep, { now }),
  };
  const steps = { ...defaults, ...deps.steps };
  const inboxAcks = steps['inbox-acks'];
  steps['inbox-acks'] = (argv) => inboxAcks(argv.map(arg => arg === '--apply' ? '--flush' : arg));
  const { report, exitCode, lock } = await runSelfTick({
    apply, runsDir: root, now,
    steps,
    ...(deps.acquireLock === undefined ? {} : { acquireLock: deps.acquireLock }),
  });
  if (json) {
    output(JSON.stringify(sanitizePublicJson({ ...report, logCap: { state: logCap.state } })));
  } else if (report.state === 'busy') {
    output(`fleet self-tick: BUSY — ${lock === 'contended'
      ? 'another self-tick holds the lock'
      : 'the run lock could not be taken'}; no step ran`);
  } else {
    const lines = [`fleet self-tick: ${apply ? 'APPLIED' : 'DRY-RUN — no changes made'}`];
    for (const step of report.steps) {
      const detail = step.state === 'ok' ? summary(step.step, step.report) : '';
      lines.push(`  ${step.step}  ${step.state}  exit=${step.exitCode}${detail ? `  ${safe(detail)}` : ''}`);
    }
    output(lines.join('\n'));
  }
  return exitCode;
}
