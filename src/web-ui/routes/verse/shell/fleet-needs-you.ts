/**
 * routes/verse/shell/fleet-needs-you.ts — the Needs-you drawer's LOCAL fleet
 * producer (unit C1). The drawer's other items come from the server's own
 * producers over GET /api/verse/activity; the fleet actually running on this
 * Mac answers a different route — GET /api/verse/fleet/runs, the same read
 * the Ops merge pulse and Settings' source rows poll — and everything there
 * that only Mason can fix belongs in Needs you: a Claude lane whose login
 * token was rejected, a held lane, a HOLD switch file, a missing runs
 * directory, a host under pressure, and the 30-minute stall incident.
 *
 * Pure: the snapshot in, {answered, items} out — no fetch, no DOM. The items
 * are NOT NeedsYouItems (workbench-types.ts is C0's frozen contract and its
 * kind union cannot carry them), so the drawer renders them as their own
 * group — "Fleet on this Mac" — rather than widening a shared type.
 *
 * `answered` is this producer's half of the coverage rule (needs-you-model
 * splitCoverage): false when the snapshot is missing or fails the wire
 * shape, or when the runs-dir source is not healthy/degraded — then the
 * Fleet and All splits may never claim "All clear" on its behalf.
 */
import { formatDateTime } from '../../../components/format/locale-format.js';
import { newestLeaderPassMs, parseInboxAt } from '../fleet/interject-ack-model.js';
import { derivePulse, readPulseInput } from '../ops/merge-pulse-model.js';
import { isFleetRuns } from '../ops/ops-runs-model.js';

/** The surface an item's "Open" button takes the operator to. */
export type FleetNeedsYouTarget = 'fleet' | 'ops' | 'settings';

export interface FleetNeedsYouItem {
  id: string;
  severity: 'urgent' | 'attention';
  title: string;
  detail: string;
  /** The plain next step, in operator language — never a path. */
  nextStep: string;
  target: FleetNeedsYouTarget;
  open?: { kind: 'pane'; paneId: string } | { kind: 'terminal'; command: string };
}

export interface FleetNeedsYouResult {
  /** Whether this Mac's fleet reporting can vouch for an "All clear". */
  answered: boolean;
  items: FleetNeedsYouItem[];
}

/** The drawer's poll cadence while it is open. */
export const FLEET_NEEDS_YOU_POLL_MS = 15_000;
export const LEADER_PASS_CADENCE_MS = 15 * 60_000;
export const LEADER_OVERDUE_MS = 2 * LEADER_PASS_CADENCE_MS;

/**
 * A server status line is printed only when it cannot smuggle a path or a
 * second line onto the screen (the honesty rule: basenames only). A line
 * that fails this is replaced by a fixed sentence.
 */
const SAFE_STATUS = /^[\w .:()-]{1,160}$/;

/** Below these free readings the host itself is the problem. */
const LOW_DISK_GB = 10;
const LOW_MEM_PCT = 10;

/** Match the Host pane's disk thresholds; unknown readings are not alerts. */
export function diskLowSeverity(freeGb: number | null): 'danger' | 'warning' | null {
  return freeGb === null ? null : freeGb < 5 ? 'danger' : freeGb < 20 ? 'warning' : null;
}

export function deriveFleetNeedsYou(snapshot: unknown, nowMs: number): FleetNeedsYouResult {
  if (!isFleetRuns(snapshot)) return { answered: false, items: [] };
  const runsDir = snapshot.sources.runsDir;
  const answered = runsDir === 'healthy' || runsDir === 'degraded';
  const items: FleetNeedsYouItem[] = [];

  const lane = snapshot.claudeLane;
  if (lane !== null && /down/i.test(lane)) {
    items.push({
      id: 'claude-lane-down',
      open: { kind: 'terminal', command: '~/.ashlr-runs/bin/fix-claude-lane.sh' },
      severity: 'urgent',
      title: 'The Claude lane is down',
      detail: SAFE_STATUS.test(lane) ? `Claude lane: ${lane}` : 'The lane reported itself down.',
      nextStep: "Run the Claude lane fix script from the runs directory's bin folder, then check Fleet",
      target: 'fleet',
    });
  }

  if (snapshot.switches.length > 0) {
    items.push({
      id: 'switches-on',
      severity: 'urgent',
      title: `Dispatch is paused by ${snapshot.switches.join(', ')}`,
      detail: 'Switch files in the runs directory hold every new dispatch.',
      nextStep: 'Clear them in Fleet ▸ Switches',
      target: 'fleet',
    });
  }

  if (runsDir === 'missing') {
    items.push({
      id: 'runs-dir-missing',
      severity: 'urgent',
      title: 'The runs directory is missing on this Mac',
      detail: 'The fleet cannot read runs, lanes or switches until it exists.',
      nextStep: 'Start the dispatcher once to create it — Settings ▸ Connection lists every source',
      target: 'settings',
    });
  }

  // The shared stall rule (merge-pulse-model.ts): nothing started and
  // nothing merged for 30 minutes is an incident, not a quiet hour.
  const pulse = derivePulse(readPulseInput(snapshot), nowMs);
  if (pulse.state === 'incident') {
    items.push({
      id: 'stall-incident',
      open: { kind: 'pane', paneId: 'leader-journal' },
      severity: 'urgent',
      title: pulse.headline,
      detail: pulse.detail ?? 'Nothing started and nothing merged for 30 minutes.',
      nextStep: 'Check Live runs and the leaders in Ops',
      target: 'ops',
    });
  }

  const newestPass = newestLeaderPassMs(snapshot.leaders, Date.parse(snapshot.generatedAt));
  if (answered && snapshot.switches.length === 0 && snapshot.paused !== true && pulse.state !== 'incident'
    && (snapshot.leaders.length === 0 || (newestPass !== null && nowMs - newestPass > LEADER_OVERDUE_MS))) {
    const waiting = snapshot.inbox.filter(entry => {
      if (snapshot.leaders.length === 0) return true;
      const at = parseInboxAt(entry.at, nowMs);
      return at !== null && newestPass !== null && at > newestPass;
    }).length;
    items.push({
      id: 'leader-overdue',
      open: { kind: 'pane', paneId: 'leader-journal' },
      severity: 'urgent',
      title: newestPass === null ? 'No leader process is running' : `No leader pass for ${Math.floor((nowMs - newestPass) / 60_000)} minutes`,
      detail: waiting === 0 ? 'Nothing is waiting in the inbox yet' : `${waiting} inbox entries are waiting on a leader`,
      nextStep: 'Check the leaders in Ops and restart the leader loop if it stopped', target: 'ops',
    });
  }

  for (const l of snapshot.lanes) {
    if (!l.held) continue;
    items.push({
      id: `lane-held:${l.lane}`,
      open: { kind: 'pane', paneId: 'fleet-lanes' },
      severity: 'attention',
      title: `Lane ${l.lane} is held`,
      detail: l.heldReason ?? 'No reason recorded',
      nextStep: 'Check the lane in Ops ▸ Live runs',
      target: 'ops',
    });
  }

  const personal = snapshot.codexPersonal;
  const personalLane = snapshot.lanes.find((l) => l.lane === 'codex-personal');
  const heldForLimit = personalLane?.held && /usage|limit/i.test(personalLane.heldReason ?? '');
  const used = personal?.usedPct;
  const resetMs = personal?.resetsAt ? Date.parse(personal.resetsAt) : NaN;
  const reset = Number.isFinite(resetMs)
    ? formatDateTime(resetMs, 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    : null;
  if ((used != null && used >= 100) || heldForLimit) {
    items.push({
      id: 'supply-personal-out',
      open: { kind: 'pane', paneId: 'fleet-supply' },
      severity: (personalLane?.queued ?? 0) > 0 ? 'urgent' : 'attention',
      title: `Personal Codex is out${reset ? ` until ${reset}` : ''}`,
      detail: personalLane ? `${personalLane.queued} jobs are waiting on it` : 'Queue size is unknown',
      nextStep: 'Those jobs wait for the reset; the leaders should route new work elsewhere',
      target: 'fleet',
    });
  } else if (used != null && used >= 90) {
    const asOf = personal?.asOf ? Date.parse(personal.asOf) : NaN;
    const minutes = Number.isFinite(asOf) && asOf <= nowMs
      ? Math.max(0, Math.round((asOf + (100 - used) / 4 * 3_600_000 - nowMs) / 60_000))
      : null;
    const detail = [
      personalLane ? `${personalLane.queued} jobs queued on codex-personal` : null,
      minutes !== null ? `out in about ${minutes} min` : null,
      reset ? `resets ${reset}` : null,
    ].filter((part): part is string => part !== null).join(' · ');
    items.push({
      id: 'supply-personal-low',
      open: { kind: 'pane', paneId: 'fleet-supply' },
      severity: 'attention',
      title: `Personal Codex is at ${used}%`, detail,
      nextStep: 'Move new work to Devin and local lanes before it runs out', target: 'fleet',
    });
  }

  const diskSeverity = diskLowSeverity(snapshot.diskFreeGb);
  if (diskSeverity !== null) {
    items.push({
      id: 'host-disk-low',
      open: { kind: 'pane', paneId: 'fleet-host' },
      severity: diskSeverity === 'danger' ? 'urgent' : 'attention',
      title: diskSeverity === 'danger' ? 'Disk is critically full on this Mac' : 'Disk is nearly full on this Mac',
      detail: `${snapshot.diskFreeGb} GB free. Workers clone repos and write logs here; a full disk halts every lane.`,
      nextStep: 'Free space: empty ~/.ashlr-runs/archive and old worker clones, then recheck in the Host pane.',
      target: 'ops',
    });
  }

  const pressure = [
    snapshot.diskFreeGb !== null && snapshot.diskFreeGb < LOW_DISK_GB ? `disk free ${snapshot.diskFreeGb} GB` : null,
    snapshot.memFreePct !== null && snapshot.memFreePct < LOW_MEM_PCT ? `memory free ${snapshot.memFreePct} %` : null,
  ].filter((reading): reading is string => reading !== null);
  if (pressure.length > 0) {
    items.push({
      id: 'host-pressure',
      open: { kind: 'pane', paneId: 'fleet-host' },
      severity: 'attention',
      title: 'This Mac is under pressure',
      detail: pressure.join(' · '),
      nextStep: 'Free disk space or memory on this Mac — Ops shows the numbers',
      target: 'ops',
    });
  }

  for (const l of snapshot.lanes) {
    if (l.running !== 0 || l.target <= 0 || l.queued <= 0 || l.held) continue;
    items.push({
      id: `lane-idle:${l.lane}`,
      open: { kind: 'pane', paneId: 'fleet-lanes' },
      severity: 'attention',
      title: `Lane ${l.lane} is idle`,
      detail: `${l.queued} queued jobs but nothing is running.`,
      nextStep: `Lane ${l.lane} has ${l.queued} queued and nothing running; check its hold and target in Lanes`,
      target: 'fleet',
    });
  }

  const pendingDrop = snapshot.drop?.pending.length ?? 0;
  if (pendingDrop > 0) {
    items.push({
      id: 'drop-pending',
      open: { kind: 'pane', paneId: 'leader-journal' },
      severity: 'attention',
      title: 'Leader jobs awaiting ingest',
      detail: `${pendingDrop} pending drop ${pendingDrop === 1 ? 'file' : 'files'}.`,
      nextStep: `${pendingDrop} pending drop ${pendingDrop === 1 ? 'file' : 'files'}; ingest sweeps every few minutes`,
      target: 'ops',
    });
  }

  return { answered, items };
}
