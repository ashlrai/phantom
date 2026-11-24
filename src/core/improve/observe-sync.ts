/**
 * Scheduled post-merge observation for the outcome ledger — the cloud
 * improve tick's evidence pass.
 *
 * `phm improve observe --repo <dir>` records when a registered proposal's
 * PR merged and whether a later default-branch commit reverted it (and the
 * same revert state for merged cloud tasks), but it is a manual verb: the
 * ledger only learns what happened to its PRs when an operator runs it
 * against a checkout. This pass runs the same observation on the
 * scheduler's hourly improve tick, against the fleet's enrolled mirrors —
 * the clones the autonomous lane already keeps fetched under
 * ~/.ashlr/fleet/mirrors — so merge and revert evidence reaches the ledger
 * without anyone remembering the verb. A repository with candidates but
 * no valid mirror keeps its observations unknown; the pass never creates a
 * mirror, never fetches into an unenrolled path and never guesses.
 *
 * Total like syncCloudBacklogOutcomes: an unreadable ledger, an
 * unavailable store or a failed append is reported in the result, and a
 * second call appends nothing — observeOutcomes emits only observations
 * the scored ledger does not already hold.
 */
import { listCloudTasks, readCloudTask, writeCloudTask } from '../cloud/store.js';
import type { CloudTaskV1 } from '../cloud/types.js';
import { listMirrors, type MirrorStatus } from '../fleet/mirrors.js';
import { observeCloudReverts, observeOutcomes, type ObserveExec } from './observe.js';
import { assertOriginIs, defaultBranchOf } from './promote.js';
import { appendLedger, readLedger, scoreOutcomes, type LedgerEvent, type LedgerRead, type ProposalOutcome } from './outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Problems kept per pass; the scheduler only needs to know observation degraded, not every row. */
const MAX_OBSERVE_ERRORS = 25;

export interface ObserveSyncDeps {
  /** Outcome ledger read; defaults to readLedger. */
  ledger?: () => LedgerRead;
  /** Ledger append; defaults to appendLedger. */
  append?: (event: LedgerEvent) => unknown;
  /** Cloud task store read; defaults to every stored task. */
  tasks?: () => readonly CloudTaskV1[];
  /** Single-task read for the revert rewrite; defaults to readCloudTask. */
  readTask?: (id: string) => CloudTaskV1 | null;
  /** Single-task write for the revert rewrite; defaults to writeCloudTask. */
  writeTask?: (task: CloudTaskV1) => unknown;
  /** Mirror inventory; defaults to listMirrors. */
  mirrors?: () => readonly MirrorStatus[];
  /** git/gh exec shared by the observation and branch/origin reads (tests). */
  exec?: ObserveExec;
}

export interface ObserveSyncResult {
  /** False when the ledger could not be read intact; nothing was written. */
  intact: boolean;
  /** Digest-chain break reasons when intact is false. */
  reasons: string[];
  /** Repositories whose candidates were scanned against a usable mirror. */
  scanned: number;
  /** 'observed' ledger events appended by this pass. */
  appended: number;
  /** Cloud tasks whose outcome.revertedBy this pass rewrote. */
  cloudUpdated: number;
  /**
   * Repositories that had observation candidates but no usable fleet
   * mirror — their merges and reverts stay unobserved (unknown), the same
   * state the manual verb leaves them in.
   */
  skipped: { repository: string; reason: string }[];
  /** Bounded, scrubbed per-repository problems; empty on a clean pass. */
  errors: string[];
  /** Set when the pass stopped before finishing; absent on a complete run. */
  reason?: 'source-unavailable' | 'append-failed';
}

interface RepoCandidates {
  /** First-seen casing of the repository name, for gh/git calls and reports. */
  repository: string;
  outcomes: ProposalOutcome[];
  tasks: CloudTaskV1[];
}

function pushError(out: ObserveSyncResult, text: string): void {
  if (out.errors.length >= MAX_OBSERVE_ERRORS) return;
  out.errors.push(scrubSecrets(text).replace(/[\r\n\t]+/g, ' ').slice(0, 200));
}

/**
 * Run post-merge observation for every repository the ledger or the cloud
 * task store has candidates for, using that repository's enrolled fleet
 * mirror as the checkout. Never throws: degraded inputs land in the result.
 */
export function syncImproveObservations(deps: ObserveSyncDeps = {}): ObserveSyncResult {
  const out: ObserveSyncResult = { intact: true, reasons: [], scanned: 0, appended: 0, cloudUpdated: 0, skipped: [], errors: [] };
  let read: LedgerRead;
  try {
    read = (deps.ledger ?? readLedger)();
  } catch {
    return { ...out, intact: false, reasons: ['ledger-unreadable'], reason: 'source-unavailable' };
  }
  if (!read.intact) return { ...out, intact: false, reasons: read.reasons };

  let outcomes: ProposalOutcome[];
  let tasks: readonly CloudTaskV1[];
  let mirrors: readonly MirrorStatus[];
  try {
    outcomes = scoreOutcomes(read.records).filter((o) => o.pr !== null);
    tasks = (deps.tasks ?? (() => listCloudTasks(Number.MAX_SAFE_INTEGER)))();
    mirrors = (deps.mirrors ?? listMirrors)();
  } catch {
    return { ...out, reason: 'source-unavailable' };
  }

  const byRepo = new Map<string, RepoCandidates>();
  const group = (repository: string): RepoCandidates => {
    const key = repository.toLowerCase();
    let g = byRepo.get(key);
    if (!g) { g = { repository, outcomes: [], tasks: [] }; byRepo.set(key, g); }
    return g;
  };
  for (const o of outcomes) group(o.pr!.repository).outcomes.push(o);
  for (const t of tasks) {
    // observeCloudReverts' own filter: merged tasks whose tracker recorded
    // the merge commit — the only cloud rows observation can place.
    if (t.state === 'merged' && t.pr && t.outcome?.mergeSha) group(t.repo).tasks.push(t);
  }
  if (byRepo.size === 0) return out;

  const mirrorByName = new Map(mirrors.map((m) => [m.nameWithOwner.toLowerCase(), m]));
  const append = deps.append ?? ((event: LedgerEvent) => appendLedger(event));
  const readTask = deps.readTask ?? readCloudTask;
  const writeTask = deps.writeTask ?? writeCloudTask;
  const exec = deps.exec;

  for (const key of [...byRepo.keys()].sort()) {
    const g = byRepo.get(key)!;
    const mirror = mirrorByName.get(key);
    if (!mirror || !mirror.present) {
      out.skipped.push({ repository: g.repository, reason: mirror?.problem ? 'mirror-invalid' : 'no-mirror' });
      if (mirror?.problem) pushError(out, `${g.repository}: fleet mirror unusable: ${mirror.problem}`);
      continue;
    }
    const repoDir = mirror.path;
    try {
      // The mirror's origin is github.com/<owner>/<name> by construction;
      // the check is cheap insurance that every git fact below is about
      // this repository and not a repointed remote.
      assertOriginIs(g.repository, repoDir, exec);
    } catch {
      out.skipped.push({ repository: g.repository, reason: 'origin-mismatch' });
      continue;
    }
    let branch: string;
    try {
      branch = defaultBranchOf(g.repository, repoDir, exec);
    } catch (err) {
      pushError(out, `${g.repository}: default branch unreadable: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    out.scanned += 1;

    const res = observeOutcomes(g.outcomes, repoDir, branch, exec);
    for (const event of res.events) {
      try {
        append(event);
      } catch {
        return { ...out, reason: 'append-failed' };
      }
      out.appended += 1;
    }
    for (const e of res.errors) pushError(out, `${g.repository}: ${e}`);

    const cloud = observeCloudReverts(g.tasks, g.repository, repoDir, branch, exec);
    for (const c of cloud.changes) {
      try {
        const t = readTask(c.taskId);
        if (!t?.outcome) continue;
        writeTask({ ...t, outcome: { ...t.outcome, revertedBy: c.revertedBy } });
        out.cloudUpdated += 1;
      } catch (err) {
        pushError(out, `${g.repository}: cloud task ${c.taskId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const e of cloud.errors) pushError(out, `${g.repository}: ${e}`);
  }
  return out;
}
