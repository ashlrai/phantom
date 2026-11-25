/**
 * `ashlr fleet self-tick` — one locked pass of Phantom's self-management for
 * a host timer or an agent with no desktop app open. It calls the fifteen
 * one-shot stages in the fixed order reset-release → lane-autohold
 * → stray-stop → meter-incident → planner-tick → inbox-acks → owner-live → order-notices → board-notify → recheck-record → needs-triage → waste-incident → teammate-overdue → landed-sweep → cos-work, each with --json (plus --apply and --runs-dir when given),
 * and folds their parsed reports into one run report. Only one self-tick runs
 * per runs dir; a step that fails or throws never stops the later ones.
 */
import { takeLoadSnapshot } from '../core/fleet/load-history.js';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { cmdFleetResetRelease } from './fleet-reset-release.js';
import { cmdFleetLaneAutohold } from './fleet-lane-autohold.js';
import { cmdFleetPlannerTick } from './fleet-planner-tick.js';
import { cmdFleetInboxAcks, type FleetInboxAcksDeps } from './fleet-inbox-acks.js';
import { cmdFleetOrderNotices, type FleetOrderNoticesDeps } from './fleet-order-notices.js';
import { cmdFleetBoardNotify } from './fleet-board-notify.js';
import { cmdFleetRecheckRecord } from './fleet-recheck-record.js';
import { cmdFleetOwnerLive } from './fleet-owner-live.js';
import type { OwnerThreadOptions } from '../core/comms/owner-thread.js';
import { cmdFleetNeedsTriage } from './fleet-needs-triage.js';
import { cmdFleetWasteIncident } from './fleet-waste-incident.js';
import type { readWasteRiskInputs } from '../core/resources/waste-risk-read.js';
import { cmdFleetLandedSweep } from './fleet-landed-sweep.js';
import { cmdFleetCosWork } from './fleet-cos-work.js';
import { QueueStore } from '../core/queue/store.js';
import type { SpawnLike } from '../core/fleet/planner-run.js';
import { runSelfTick, type RunSelfTickOptions, type SelfTickStep, type SelfTickSteps } from '../core/fleet/self-tick.js';
import { claudeQuotaFromLedger, refreshClaudeQuotaPeriodically, refreshHeldClaudeQuota, type PeriodicClaudeQuotaReport, type Probe } from '../core/fleet/claude-quota-refresh.js';
import { readSelfTickLast } from '../core/fleet/self-tick-last.js';
import { gapsHookLine, hooksFromPlannerReport, readSelfTickStatus, selfTickStatusLines } from '../core/fleet/self-tick-status.js';
import { capSelfTickLog, selfTickLogPath } from '../core/fleet/self-tick-log-cap.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { cmdFleetStrayStop, type StuckStepDeps } from './fleet-stray-stop.js';
import type { StrayStopDeps } from '../core/fleet/stray-stop.js';
import { defaultMeterDropReaders } from '../core/fleet/meter-drop-readers.js';
import type { LaneTruthReaders } from '../core/fleet/lane-truth.js';
import { readMeterDrop } from './fleet-meter-drop.js';
import { postMeterIncidents } from '../core/fleet/meter-incident.js';
import { awakeEnabled, holdKeepAwake, type AwakeDeps } from '../core/fleet/keep-awake.js';
import { recordClockSample } from '../core/fleet/sleep-gaps.js';
import { orderReadyFile } from '../core/fleet/ready-yield.js';
import { recordDiskSample } from '../core/fleet/host-disk.js';

const usage = `Usage: ashlr fleet self-tick [--json] [--runs-dir <abs>] [--apply] [--last] [--status]
Default: a dry run that changes nothing and says what it would do. Switch to a real run with --apply,
or, when there is no terminal (a host timer), by setting PHM_SELF_TICK_APPLY=1. Every run, dry or
not, writes queue/self-tick-last.json and appends one line to queue/self-tick.jsonl (newest 500 kept).
One locked pass of Phantom's self-management: reset-release first (it first
refreshes Claude's native weekly reading when the persisted one is older than
30 minutes, probing once on --apply only; a lane it frees counts as a free slot for the planner step), then lane-autohold, then
stray-stop (bounded guarded recovery), then meter-incident (deduped flat-meter
notices), then planner-tick, then inbox-acks (sends pending same-channel acks), then owner-live
(sends each newly-live owner channel its one-time 'Leader is live here' notice), then order-notices
(tells Mason when a merged job served one of his orders), then board-notify
(posts once-only ASSIGNED / BLOCKED / VERIFIED work-board changes into each item's source thread; the first live pass only records a baseline), then recheck-record
(appends the read-only fleet recheck verdict to the capped local recheck log; a dry run records nothing), then needs-triage
(auto-resolves Needs-you items outside the four hard limits; secrets, money,
outside sends and data destruction stay for Mason), then waste-incident (reports high-waste lanes), then teammate-overdue (notices the owner thread about unanswered teammate texts), then landed-sweep (closes DIRTY PRs whose work already landed;
followed by cos-work, which drafts at most one reply with a 3-minute runner timeout). Without --apply nothing is released, held, spawned, acknowledged, notified, resolved or recorded — the
planner step still appends its observational PLANNER_TICK line to
queue/dispatch-events.log either way. Only one self-tick runs per runs dir:
a held queue/self-tick.lock reports 'busy' and exits 0. A step that fails or
throws never stops the later ones. Each completed pass records itself to
queue/self-tick-last.json while the lock is still held; --last prints that
recorded run (or 'no recorded run') without running a step or taking the
lock, combines only with --json and --runs-dir, and exits 0 even when
nothing is recorded. --status is the plain-words twin of --last: when the self-tick last ran and how many items each hook produced (autofill, gaps, reap, stranded-requeue), or 'no self-tick run recorded'; it reads the same file, takes no lock, combines only with --json and --runs-dir (schema fleet.self-tick-status.v1). Exit 0 when every step is ok/skipped or the run is busy, 1
when any step failed, 2 on usage.`;

interface Dependencies {
  now?: () => number;
  /** Recovery evidence and signal seams; the guarded stop path owns all signals. */
  stray?: Partial<Pick<StrayStopDeps, 'readStraySlots' | 'kill'>> & { stuck?: Partial<StuckStepDeps> };
  meterReaders?: LaneTruthReaders;
  /** Isolated bus store for fixtures or explicit configured intent. Never derived
   * from the runs dir; unset, the ordinary default bus is used on the canonical
   * runs root only. */
  busRoot?: string;
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Per-step overrides for tests; unlisted steps run the real verbs. */
  steps?: Partial<SelfTickSteps>;
  /** Best-effort, rate-limited host-load evidence after an applied tick. */
  loadSnapshot?: (runsDir: string) => Promise<unknown>;
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
  /** Owner-thread options for tests; production defaults come from ownerThreadOptions(). */
  ownerOptions?: OwnerThreadOptions;
  /** Needs-you triage read/resolve/bus seams for tests; production defaults are unchanged. */
  needsTriage?: Pick<NonNullable<Parameters<typeof cmdFleetNeedsTriage>[1]>, 'read' | 'resolve' | 'bus'>;
  wasteRead?: typeof readWasteRiskInputs;
  /** board-notify verb seam so tests never reach a real sender or Slack. */
  boardNotify?: (args: string[]) => Promise<number>;
  /** recheck-record verb seam for tests; the real call is cmdFleetRecheckRecord([]). */
  recheckRecord?: () => Promise<number>;
  /** Native claude usage probe seam; tests fake it, never a real claude spawn. */
  claudeProbe?: Probe;
  /** claude command-finder seam; tests pin it, never a real PATH scan. */
  claudeFindCommand?: () => string | null;
  /** Autofill seams for tests (lane read, kill switch, fill); production reads the real lanes and config. */
  autofill?: Partial<Pick<import('../core/fleet/autofill-run.js').AutofillTickOptions, 'readLanes' | 'readOff' | 'fill'>>;
  masonDigest?: Partial<Pick<import('../core/comms/mason-digest.js').MasonDigestTickOptions, 'readOff' | 'readers' | 'post' | 'owner'>>;
  /** Terminal seam for the PHM_SELF_TICK_APPLY rule; production reads process.stdout.isTTY. */
  isTty?: boolean;
  /** Environment seam for tests; production reads process.env. */
  env?: Record<string, string | undefined>;
  /** Free-disk reading seam for tests; production reads the real volume. */
  diskSample?: () => Promise<import('../core/fleet/host-top-view.js').HostDiskSample | null>;
  /** Keep-awake seams for tests (platform, power, caffeinate spawn, queue depth); production reads the real ones. */
  awake?: AwakeDeps & { queued?: () => Promise<number | null> };
  /** Empty-family stop seams for tests (kill switch, report); production reads the real config and ledger. */
  emptyStop?: Partial<Pick<Parameters<typeof import('../core/fleet/empty-family-apply.js').runEmptyApplyTick>[0], 'readOff' | 'readReport'>>;
  /** Worktree reap seams for tests (readers, remover); production reads the real worktrees. */
  worktreeReap?: import('../core/fleet/worktrees.js').WorktreesDeps;
  /** Stranded-requeue seam for tests; production plans over the real runs dir. */
  strandedRequeue?: typeof import('../core/fleet/stranded-requeue.js').planStrandedRequeue;
  /** Publish-resume sweep seam for tests; production sweeps the real runs dir. */
  publishResume?: typeof import('../core/fleet/publish-resume-sweep.js').sweepPublishResumes;
  /** Ready ordering seam; called once inside the planner stage. */
  orderReady?: typeof orderReadyFile;
  /** Asks sync seam for tests; production syncs the real needs-you ledger. */
  asksSync?: typeof import('../core/fleet/asks-sync.js').syncAsks;
}

/** The escaped, home-scrubbed spelling of one value for human output. */
const safe = (value: unknown): string => JSON.stringify(sanitizePublicJson(value))
  .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Why a failed step failed, in plain words: the step's own `reason`, else the thrown error, else a note that nothing was reported. */
function failureReason(report: unknown, error: string | undefined): string {
  const reason = typeof report === 'object' && report !== null ? (report as Record<string, unknown>)['reason'] : undefined;
  if (typeof reason === 'string' && reason) return `reason: ${reason}`;
  return error ? `error: ${error}` : 'no reason reported';
}

/** A short per-step summary for human output, read defensively. */
function summary(step: string, report: unknown): string {
  if (typeof report !== 'object' || report === null) return '';
  const row = report as Record<string, unknown>;
  if (typeof row['skippedReason'] === 'string' && row['skippedReason'].trim()) return `skipped: ${row['skippedReason']}`;
  const count = (value: unknown): number => Array.isArray(value) ? value.length : 0;
  if (step === 'cos-work') {
    return row['mode'] === 'dry-run' ? `pending=${row['pending']}` : `outcome=${row['outcome']}`;
  }
  if (step === 'planner-tick') {
    const autofill = row['autofill'] as Record<string, unknown> | undefined;
    const runs = Array.isArray(autofill?.['runs']) ? autofill['runs'] as Record<string, unknown>[] : [];
    const applied = runs.reduce((sum, r) => sum + (typeof r['applied'] === 'number' ? r['applied'] : 0), 0);
    const base = typeof (row['reason'] ?? row['outcome']) === 'string' ? String(row['reason'] ?? row['outcome']) : '';
    const gap = hooksFromPlannerReport(row).find(h => h.hook === 'gaps');
    const gapNote = gap ? `  ${gapsHookLine(gap)}` : '';
    return runs.length ? `${base}  autofill=${applied} applied across ${runs.length} starved ${runs.length === 1 ? 'lane' : 'lanes'}${gapNote}`.trim() : base;
  }
  if (step === 'reset-release') {
    const quota = row['claudeQuota'] as Record<string, unknown> | null | undefined;
    const quotaState = typeof quota?.['state'] === 'string' ? `  claude-quota=${quota['state']}` : '';
    return `released=${count(row['released'])} planned=${count(row['planned'])}${quotaState}`;
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
  if (step === 'owner-live') {
    return `sent=${count(row['sent'])} planned=${count(row['planned'])}`;
  }
  if (step === 'order-notices') {
    const n = (value: unknown): number => typeof value === 'number' ? value : 0;
    const digest = row['masonDigest'] as Record<string, unknown> | undefined;
    return `sent=${n(row['sent'])} planned=${count(row['notices'])}${typeof digest?.['state'] === 'string' ? ` digest=${digest['state']}` : ''}`;
  }
  if (step === 'board-notify') {
    const n = (value: unknown): number => typeof value === 'number' ? value : 0;
    return `sent=${n(row['sent'])} planned=${n(row['planned'])}`;
  }
  if (step === 'recheck-record') {
    const recorded = row['recorded'];
    return typeof recorded === 'string' ? recorded : '';
  }
  if (step === 'needs-triage') {
    return `auto=${count(row['auto'])} needs-mason=${count(row['hardLimit'])}`;
  }
  if (step === 'waste-incident') {
    const posts = Array.isArray(row['posted']) ? row['posted'] : [];
    const stored = posts.filter((post) => post !== null && typeof post === 'object' && (post as Record<string, unknown>)['status'] === 'posted').length;
    return `planned=${count(row['planned'])} posted=${stored}`;
  }
  if (step === 'teammate-overdue') {
    const state = typeof row['state'] === 'string' ? row['state'] : 'unknown';
    const n = (value: unknown): number => typeof value === 'number' ? value : 0;
    return `${state} raised=${n(row['raised'])} skipped=${n(row['skipped'])}`;
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
  let json = false, apply = false, last = false, status = false, runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--last' && !last) last = true;
    else if (arg === '--status' && !status) status = true;
    else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else return invalid();
  }
  // The default is a dry run. A run with no terminal (a host timer) applies when the host sets
  // PHM_SELF_TICK_APPLY=1; a person at a terminal must still pass --apply. Read-only modes ignore it.
  const flagApply = apply;
  if (!last && !status && !apply && (deps.env ?? process.env).PHM_SELF_TICK_APPLY === '1' && !(deps.isTty ?? process.stdout.isTTY === true)) apply = true;
  // --last is a read-only report of the last recorded pass: nothing runs,
  // no lock is taken, so --apply has no meaning beside it.
  if ((last || status) && flagApply) return invalid();
  if (last && status) return invalid();
  // One root for the lock and all fifteen steps: the verbs' own fallbacks
  // (ASHLR_RUNS_DIR, ~/.ashlr-runs) resolve here once, so the lock domain
  // and the released slots can never drift to different dirs.
  const home = deps.home ?? homedir();
  const root = resolve(runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(home, '.ashlr-runs'));
  const now = deps.now ?? Date.now;
  if (status) {
    const report = readSelfTickStatus(root, now());
    if (json) output(JSON.stringify(sanitizePublicJson(report)));
    else for (const line of selfTickStatusLines(report)) output(line);
    return 0;
  }
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
  // When pulse says a lane is starved, fill it from bets (capped per hour; off with autofill.off). Never fails the tick.
  const runAutofillStage = async (): Promise<unknown> => {
    // Account-root only, like the other steps that write real queue state: a sandbox runs dir is never filled.
    if (!deps.autofill && root !== join(home, '.ashlr-runs')) return { reason: 'custom-runs-dir-no-autofill' };
    try {
      const { runAutofillTick } = await import('../core/fleet/autofill-run.js');
      const { HELP_ENTRIES } = await import('./help.js');
      const options = {
        runsDir: root, apply, now, root: process.cwd(), entries: HELP_ENTRIES,
        readLanes: async () => (await import('../core/fleet/live-lane-facts.js')).readLiveLaneFacts(root),
        ...deps.autofill,
      };
      const view = await options.readLanes().catch(() => null);
      const supply = await (await import('../core/fleet/supply-floor.js')).runSupplyFloor(options, view);
      for (const row of supply) if (!json) output(row.line);
      return { ...await runAutofillTick({ ...options, readLanes: async () => view && ({ lanes: view.lanes.map(f => ({ ...f,
        queued: f.queued === null ? null : f.queued + (supply.find(row => row.lane === f.lane)?.added ?? 0) })) }) }), supply };
    } catch (error) {
      return { reason: 'autofill failed', error: error instanceof Error ? error.message.slice(0, 120) : 'unknown error' };
    }
  };
  // At most once an hour, retire READY jobs of empty-heavy families (off with empty_stop.off). Never fails the tick.
  const runEmptyStopStage = async (): Promise<unknown> => {
    if (!deps.emptyStop && root !== join(home, '.ashlr-runs')) return { reason: 'custom-runs-dir-no-empty-stop' };
    try {
      const { runEmptyApplyTick } = await import('../core/fleet/empty-family-apply.js');
      return await runEmptyApplyTick({ runsDir: root, apply, now: now(), ...deps.emptyStop });
    } catch (error) {
      return { reason: `empty-stop failed: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}` };
    }
  };
  // Above 40 job worktrees, run the safe reap (40 removals, once per 30 minutes; off with queue/worktree-reap.off). Never fails the tick.
  const runWorktreeReapStage = async (): Promise<unknown> => {
    if (!deps.worktreeReap && root !== join(home, '.ashlr-runs')) return { state: 'skipped', reason: 'custom-runs-dir-no-worktree-reap' };
    try {
      const { runWorktreeReapTick } = await import('../core/fleet/worktree-reap-tick.js');
      return await runWorktreeReapTick({ runsDir: root, apply, now: now(), ...(deps.worktreeReap ? { deps: deps.worktreeReap } : {}) });
    } catch (error) { return { state: 'failed', error: error instanceof Error ? error.message.slice(0, 120) : 'unknown error' }; }
  };
  // One asks sync per tick: raises the sign-in and expiring-credit asks and closes cleared ones. Never fails the tick.
  const runAsksSyncStage = async (): Promise<unknown> => {
    if (!deps.asksSync && root !== join(home, '.ashlr-runs')) return { state: 'skipped', reason: 'custom-runs-dir-no-asks-sync' };
    try {
      const { syncAsks } = await import('../core/fleet/asks-sync.js');
      return await (deps.asksSync ?? syncAsks)({ runsDir: root, now, dryRun: !apply });
    } catch { return { state: 'skipped', reason: 'asks sync failed' }; }
  };
  // Finished jobs whose publish aborted on the fetch race get a recovery row (at most 3 per tick). Never fails the tick.
  const runStrandedRequeueStage = async (): Promise<unknown> => {
    if (!deps.strandedRequeue && root !== join(home, '.ashlr-runs')) return { reason: 'custom-runs-dir-no-stranded-requeue' };
    try {
      const { planStrandedRequeue, readGhLaneSlots } = await import('../core/fleet/stranded-requeue.js');
      const { landedReposFromEnv, readLandedFromGit } = await import('../core/fleet/landed-from-git.js');
      return await (deps.strandedRequeue ?? planStrandedRequeue)(root, { apply, limit: 3, now: now(), ghSlots: readGhLaneSlots, landed: () => readLandedFromGit({ sinceHours: 168, repos: landedReposFromEnv() }) });
    } catch (error) { return { error: error instanceof Error ? error.message.slice(0, 120) : 'unknown error' }; }
  };
  // Publishes that pushed a branch but aborted before the PR get a bounded resume pass
  // (opens the PR, never arms auto-merge; the merge queue's gated path decides). Never fails the tick.
  const runPublishResumeStage = async (): Promise<unknown> => {
    if (!deps.publishResume && root !== join(home, '.ashlr-runs')) return { reason: 'custom-runs-dir-no-publish-resume' };
    try {
      const { sweepPublishResumes } = await import('../core/fleet/publish-resume-sweep.js');
      return await (deps.publishResume ?? sweepPublishResumes)({ runsDir: root, apply, now: () => now() });
    } catch (error) { return { error: error instanceof Error ? error.message.slice(0, 120) : 'unknown error' }; }
  };
  const runMasonDigestStage = async (): Promise<unknown> => {
    // The owner thread lives on the real account root; a sandbox runs dir never posts unless a test injects the seams.
    if (!deps.masonDigest && root !== join(homedir(), '.ashlr-runs')) return { reason: 'custom-runs-dir-no-owner-thread' };
    try {
      const { tickMasonDigest } = await import('../core/comms/mason-digest.js');
      const { fixedOwnerConfigDir, loadOwnerThreadSettings } = await import('../core/comms/owner-channel.js');
      const at = now();
      const report = await tickMasonDigest({
        runsDir: root, now: at, apply,
        owner: { runsDir: root, now: () => at, settings: loadOwnerThreadSettings(fixedOwnerConfigDir()) },
        ...deps.masonDigest,
      });
      return { ...report, digest: report.digest === null ? null : { has_news: report.digest.has_news, lines: report.digest.lines } };
    } catch (error) {
      return { reason: `mason digest failed: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}` };
    }
  };
  const defaults: SelfTickSteps = {
    // The quota refresh runs first inside this step, so the reading reset-release
    // plans from is current. It is a sub-stage rather than a new step name so the
    // fixed fifteen-step order and report shape stay as they are. A custom runs
    // dir with no injected probe never scans PATH or spawns a real claude.
    'reset-release': async (argv) => {
      const sandboxed = deps.claudeProbe === undefined && deps.claudeFindCommand === undefined && root !== join(home, '.ashlr-runs');
      const probed = sandboxed
        ? { state: 'unavailable', weeklyPct: null, observedAt: null, reason: 'custom-runs-dir-no-claude-probe' } as PeriodicClaudeQuotaReport
        : await refreshClaudeQuotaPeriodically({
          runsDir: root, now, apply, probe: deps.claudeProbe, findCommand: deps.claudeFindCommand,
        });
      // A failed probe is not a failed step: fall back to the reading `phm pools` shows.
      const claudeQuota = probed.state === 'unavailable' ? await claudeQuotaFromLedger({ runsDir: root, now }) ?? probed : probed;
      const held = deps.claudeProbe === undefined && deps.claudeFindCommand === undefined ? {} : {
        refreshClaude: (o: { runsDir: string; now: () => number }) =>
          refreshHeldClaudeQuota({ ...o, probe: deps.claudeProbe, findCommand: deps.claudeFindCommand }),
      };
      const run = await bind(cmdFleetResetRelease, { now, ...held })(argv);
      try {
        const parsed: unknown = JSON.parse(run.output);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...run, output: JSON.stringify({ ...parsed, claudeQuota }) };
        }
      } catch { /* the verb's own output stands untouched */ }
      return run;
    },
    'lane-autohold': bind(cmdFleetLaneAutohold, { now: () => new Date(now()) }),
    'stray-stop': async (argv) => {
      // The default process reader is tied to the real host's canonical root.
      if (!deps.stray?.readStraySlots && root !== join(homedir(), '.ashlr-runs')) {
        return { exitCode: 0, output: JSON.stringify({ reason: 'custom-runs-dir-no-process-reader' }) };
      }
      return bind(cmdFleetStrayStop, {
        ...deps.stray,
        ledgerFile: join(root, 'stray-stops.jsonl'),
        // Ghost markers and stuck jobs ride the same apply step; the note reads "lane: N ghosts closed, M stuck stopped".
        stuck: { runsDir: root, now, ...deps.stray?.stuck },
        now: () => new Date(now()),
      })(argv);
    },
    'meter-incident': async () => {
      if (!deps.meterReaders && root !== join(home, '.ashlr-runs')) {
        return { exitCode: 0, output: JSON.stringify({ reason: 'custom-runs-dir-no-meter-reader' }) };
      }
      const report = await readMeterDrop(deps.meterReaders ?? defaultMeterDropReaders(home, now()), now());
      // A custom runs root never reaches the ordinary production bus: posting
      // there needs an explicit bus root beside the injected meter readers.
      if (apply && !deps.busRoot && root !== join(home, '.ashlr-runs')) {
        return { exitCode: 0, output: JSON.stringify({ report, posted: [], reason: 'custom-runs-dir-no-bus-root' }) };
      }
      const posted = apply ? postMeterIncidents(report, now(), undefined, {
        now, ...(deps.busRoot === undefined ? {} : { root: resolve(deps.busRoot) }),
      }) : [];
      return { exitCode: posted.some(row => !['posted', 'duplicate'].includes(row.status)) ? 1 : 0,
        output: JSON.stringify({ report, posted, reason: apply ? 'observed' : 'dry-run' }) };
    },
    // Empty stops precede autofill, so refill sees the new holds. Like the quota
    // refresh above it is a sub-stage, not a new step name, so the fixed order and report shape stay as they are.
    'planner-tick': async (argv) => {
      const emptyStop = await runEmptyStopStage();
      const autofill = await runAutofillStage();
      const worktreeReap = await runWorktreeReapStage();
      const asksSync = await runAsksSyncStage();
      const strandedRequeue = await runStrandedRequeueStage();
      const publishResume = await runPublishResumeStage();
      const order = await (deps.orderReady ?? orderReadyFile)(root, apply, now())
        .catch(() => ({ line: 'order: unknown (queue unavailable or busy)' }));
      const run = await bind(cmdFleetPlannerTick, { now, spawn: deps.spawn })(argv);
      try {
        const parsed: unknown = JSON.parse(run.output);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...run, output: JSON.stringify({ ...parsed, autofill, emptyStop, familyStops: (emptyStop as { familyStops?: unknown }).familyStops ?? null, worktreeReap, asksSync, strandedRequeue, publishResume, order }) };
        }
      } catch { /* the verb's own output stands untouched */ }
      return run;
    },
    'inbox-acks': bind(cmdFleetInboxAcks, { now: () => new Date(now()), senders: deps.senders }),
    'owner-live': async (argv) => {
      // The owner thread lives on the real account root; a custom runs dir is
      // a test or sandbox fixture that must never plan or send owner notices.
      if (!deps.ownerOptions && root !== join(homedir(), '.ashlr-runs')) {
        return { exitCode: 0, output: JSON.stringify({ reason: 'custom-runs-dir-no-owner-thread' }) };
      }
      return bind(cmdFleetOwnerLive,
        deps.ownerOptions === undefined ? {} : { options: deps.ownerOptions })(argv);
    },
    'order-notices': async (argv) => {
      const run = await bind(cmdFleetOrderNotices, { now, senders: deps.noticeSenders })(argv);
      const masonDigest = await runMasonDigestStage();
      try {
        const parsed: unknown = JSON.parse(run.output);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...run, output: JSON.stringify({ ...parsed, masonDigest }) };
        }
      } catch { /* the verb's own output stands untouched */ }
      return run;
    },
    'board-notify': async () => {
      // The verb prints with console.log and has no output seam, so capture
      // its stdout here. Steps run one at a time under the run lock.
      const argv = ['--json', ...(apply ? [] : ['--dry-run']), ...(deps.busRoot === undefined ? [] : ['--root', resolve(deps.busRoot)])];
      if (deps.boardNotify) return { exitCode: await deps.boardNotify(argv), output: '' };
      const captured: string[] = [];
      const realLog = console.log;
      console.log = (...parts: unknown[]) => { captured.push(parts.join(' ')); };
      try {
        return { exitCode: await cmdFleetBoardNotify(argv), output: captured.join('\n') };
      } finally { console.log = realLog; }
    },
    'recheck-record': async () => {
      // The verb rejects the shared self-tick argv as unknown flags, so it is
      // always called bare. A dry run writes nothing and never calls it.
      if (!apply) {
        return { exitCode: 0, output: JSON.stringify({ reason: 'dry-run', wouldRecord: true }) };
      }
      // The recheck log lives on the real account root; a custom runs dir is
      // a test or sandbox fixture that must never write it. An injected seam
      // is the explicit override, same as the other account-root steps.
      const run = deps.recheckRecord ?? (root === join(homedir(), '.ashlr-runs')
        ? () => cmdFleetRecheckRecord([])
        : undefined);
      if (!run) {
        return { exitCode: 0, output: JSON.stringify({ reason: 'custom-runs-dir-no-recheck-root', wouldRecord: true }) };
      }
      // The verb prints with console.log and has no output seam, so capture
      // its stdout here. Steps run one at a time under the run lock.
      const captured: string[] = [];
      const realLog = console.log;
      const realError = console.error;
      console.log = (...parts: unknown[]) => { captured.push(parts.join(' ')); };
      console.error = (...parts: unknown[]) => { error(parts.join(' ')); };
      try {
        const exitCode = await run();
        return { exitCode, output: JSON.stringify({ recorded: captured.join('\n') }) };
      } finally {
        console.log = realLog;
        console.error = realError;
      }
    },
    'needs-triage': bind(cmdFleetNeedsTriage, { ...deps.needsTriage }),
    'waste-incident': bind(cmdFleetWasteIncident, { now, read: deps.wasteRead }),
    'landed-sweep': bind(cmdFleetLandedSweep, { now }),
    'cos-work': async (argv) => {
      const result = await bind(cmdFleetCosWork, { now, spawn: deps.spawn, timeoutMs: 180_000 })(argv);
      if (result.exitCode === 1) {
        const report = JSON.parse(result.output) as { outcome?: string; id?: string; attemptId?: string };
        if (report.outcome === 'blocked' && typeof report.id === 'string') {
          const jobs = (await new QueueStore(join(root, 'queue')).read()).jobs;
          if (jobs.some(job => job.id === (report.attemptId ?? report.id) && job.status === 'READY')) return { ...result, exitCode: 0 };
        }
      }
      return result;
    },
  };
  const steps = { ...defaults, ...deps.steps };
  const inboxAcks = steps['inbox-acks'];
  steps['inbox-acks'] = (argv) => inboxAcks(argv.map(arg => arg === '--apply' ? '--flush' : arg));
  // A wall/monotonic clock sample lets `phm fleet gaps` tell a sleeping Mac from a stalled dispatcher.
  // Keep-awake (opt-in, off by default) holds a caffeinate idle-sleep assertion for this tick while work is queued.
  let hold: ReturnType<typeof holdKeepAwake> | undefined;
  if (apply) {
    recordClockSample(root, now());
    // One free-disk reading per 5 minutes feeds `phm host disk` and the digest's disk_low warning.
    await recordDiskSample(root, now(), deps.diskSample);
    if (awakeEnabled(root)) {
      const queued = await (deps.awake?.queued ?? (async () => {
        const { getLaneQueueCounts } = await import('../core/fleet/queue-counts.js');
        const { totals } = await getLaneQueueCounts({ runsDir: root });
        return totals.ready === null && totals.running === null ? null : (totals.ready ?? 0) + (totals.running ?? 0);
      }))().catch(() => null);
      hold = holdKeepAwake(root, queued, { now, ...deps.awake });
    }
  }
  const { report, exitCode, lock } = await runSelfTick({
    apply, runsDir: root, now,
    steps,
    ...(deps.acquireLock === undefined ? {} : { acquireLock: deps.acquireLock }),
  }).finally(() => hold?.release());
  if (apply && report.state === 'ran') {
    try { await (deps.loadSnapshot ?? ((dir: string) => takeLoadSnapshot(dir, { now })))(root); } catch { /* Best-effort. */ }
  }
  if (json) {
    output(JSON.stringify(sanitizePublicJson({ ...report, logCap: { state: logCap.state } })));
  } else if (report.state === 'busy') {
    output(`fleet self-tick: BUSY — ${lock === 'contended'
      ? 'another self-tick holds the lock'
      : 'the run lock could not be taken'}; no step ran`);
  } else {
    const lines = [`fleet self-tick: ${apply ? 'APPLIED' : 'DRY-RUN — no changes made'}`];
    const order = report.steps.find(s => s.step === 'planner-tick')?.report as { order?: { line: string } } | null;
    if (order?.order?.line) lines.push(order.order.line);
    for (const step of report.steps) {
      const detail = step.state === 'failed' ? failureReason(step.report, step.error) : summary(step.step, step.report);
      lines.push(`  ${step.step}  ${step.state}  exit=${step.exitCode}${detail ? `  ${safe(detail)}` : ''}`);
    }
    output(lines.join('\n'));
  }
  return exitCode;
}
