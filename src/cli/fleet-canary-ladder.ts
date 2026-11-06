/**
 * `phm fleet canary-ladder` — read-only report of which auto-merge rung each
 * repo's recent merge outcomes compute on the canary enforce ladder
 * (src/core/fleet/automerge-canary-ladder.ts).
 *
 * The default reader derives outcomes from the fleet's own merge-state
 * records under `~/.ashlr/authority/fleet-merge/` — a landed `change` merge
 * is 'merged' evidence and a landed `revert` is 'reverted' evidence. Records
 * that never merged (closed, rejected, still in flight) contribute nothing.
 * Tests inject the reader; no fixture or production path touches the network.
 *
 * Replay: each 'merged' outcome attempts the next rung up (arm from shadow,
 * enforce from armed — enforce is pinned unsupported in code, so evidence can
 * never carry a repo past armed); every other outcome rolls back to shadow,
 * the ladder's own fail-safe direction. Attempts run against a void audit
 * sink so the report changes no gate, label, ruleset, merge setting, ledger
 * or audit record — it is observation-only.
 *
 * Exit codes: 0 report printed, 1 the outcome source was degraded, 2 usage.
 */
import {
  CANARY_LADDER_DEFAULT_STATE,
  enforceGates,
  transitionCanaryLadder,
  type CanaryLadderEvent,
  type CanaryLadderRefusal,
  type CanaryLadderState,
} from '../core/fleet/automerge-canary-ladder.js';
import { listFleetMergeStateKeys, readFleetMergeState } from '../core/fleet/fleet-merge-state.js';

export const FLEET_CANARY_LADDER_USAGE = 'phm fleet canary-ladder [--json]';
const MAX_OUTCOMES_PER_REPO = 1_024;

/** A landed merge held (merged) or was undone by a landed revert (reverted). */
export type FleetCanaryLadderOutcome = 'merged' | 'reverted';

export interface FleetCanaryLadderRepoInput {
  repo: string;
  /** Recent merge outcomes for the repo, oldest first. */
  outcomes: readonly FleetCanaryLadderOutcome[];
}

/** What the reader supplies; `complete` is false when records were skipped. */
export interface FleetCanaryLadderSource {
  state: 'healthy' | 'degraded' | 'missing';
  complete: boolean;
  /** Merge-state records read successfully. */
  records: number;
  /** Records that failed validation and could not contribute outcomes. */
  corrupt: number;
  repos: readonly FleetCanaryLadderRepoInput[];
}

export interface FleetCanaryLadderNext {
  event: CanaryLadderEvent | null;
  applies: boolean;
  reason: CanaryLadderRefusal | 'no-evidence' | 'ladder-ceiling' | null;
}

export interface FleetCanaryLadderRepoRow {
  repo: string;
  /** The rung the ladder state machine computes from the replayed outcomes. */
  rung: CanaryLadderState;
  /** Outcomes replayed for this repo. */
  evidence: number;
  /** True only when evidence carried the rung above the default floor. */
  promoted: boolean;
  /** The forward transition a further held merge would attempt now. */
  nextStep: FleetCanaryLadderNext;
}

export interface FleetCanaryLadderReport {
  schema: 'fleet.canary-ladder.v1';
  authority: 'observation-only';
  generatedAt: string;
  gates: ReturnType<typeof enforceGates>;
  source: Pick<FleetCanaryLadderSource, 'state' | 'complete' | 'records' | 'corrupt'>;
  repos: FleetCanaryLadderRepoRow[];
}

export interface FleetCanaryLadderDeps {
  /** Injected outcome source; defaults to the local fleet-merge records. */
  read?: () => FleetCanaryLadderSource;
  now?: () => Date;
  output?: (text: string) => void;
}

/** The event a held merge attempts from each rung; 'enforce' re-attempts at the ceiling and is refused there. */
const CLIMB: Record<CanaryLadderState, CanaryLadderEvent> = {
  shadow: 'arm',
  armed: 'enforce',
  enforce: 'enforce',
};

/**
 * The report never persists a transition audit record; a sink that reports
 * success keeps the state machine's fail-closed semantics honest without
 * touching the real audit store.
 */
const voidAudit = (): boolean => true;

function replay(outcomes: readonly FleetCanaryLadderOutcome[]): { rung: CanaryLadderState; evidence: number } {
  let rung: CanaryLadderState = CANARY_LADDER_DEFAULT_STATE;
  let evidence = 0;
  for (const outcome of outcomes.slice(0, MAX_OUTCOMES_PER_REPO)) {
    // Anything that is not a held merge retreats to the safe floor, matching
    // the ladder's own "unknown means shadow" contract.
    const event: CanaryLadderEvent = outcome === 'merged' ? CLIMB[rung] : 'rollback';
    rung = transitionCanaryLadder(rung, event, { writeAudit: voidAudit }).state;
    evidence += 1;
  }
  return { rung, evidence };
}

function nextStepFor(rung: CanaryLadderState, evidence: number): FleetCanaryLadderNext {
  if (evidence === 0) return { event: null, applies: false, reason: 'no-evidence' };
  if (rung === 'enforce') return { event: null, applies: false, reason: 'ladder-ceiling' };
  const event = CLIMB[rung];
  const probe = transitionCanaryLadder(rung, event, { writeAudit: voidAudit });
  return { event, applies: probe.ok, reason: probe.ok ? null : probe.reason };
}

/** Pure projection: source in, report out. Exported for direct assertions. */
export function projectFleetCanaryLadder(
  source: FleetCanaryLadderSource,
  now: Date = new Date(),
): FleetCanaryLadderReport {
  const repos: FleetCanaryLadderRepoRow[] = source.repos
    .map((input) => {
      const { rung, evidence } = replay(input.outcomes);
      return {
        repo: input.repo,
        rung,
        evidence,
        promoted: rung !== CANARY_LADDER_DEFAULT_STATE,
        nextStep: nextStepFor(rung, evidence),
      };
    })
    .sort((left, right) => left.repo.localeCompare(right.repo));
  return {
    schema: 'fleet.canary-ladder.v1',
    authority: 'observation-only',
    generatedAt: now.toISOString(),
    gates: enforceGates(),
    source: {
      state: source.state,
      complete: source.complete,
      records: source.records,
      corrupt: source.corrupt,
    },
    repos,
  };
}

/**
 * Default outcome source: the local fleet-merge records. A landed `change`
 * merge is 'merged' evidence; a landed `revert` is 'reverted' evidence.
 * Everything else — in flight, closed, rejected — is not a merge outcome.
 * Local files only; never calls out.
 */
export function readFleetMergeOutcomeSource(): FleetCanaryLadderSource {
  const keys = listFleetMergeStateKeys();
  if (keys === null) {
    return { state: 'degraded', complete: false, records: 0, corrupt: 0, repos: [] };
  }
  const perRepo = new Map<string, { at: string; outcome: FleetCanaryLadderOutcome }[]>();
  let records = 0;
  let corrupt = 0;
  for (const key of keys) {
    const read = readFleetMergeState(key);
    if (read.state === 'corrupt') {
      corrupt += 1;
      continue;
    }
    if (read.state !== 'ok') continue;
    records += 1;
    const record = read.record;
    if (record.outcome !== 'merged') continue;
    const outcome: FleetCanaryLadderOutcome = record.kind === 'revert' ? 'reverted' : 'merged';
    const rows = perRepo.get(record.repo) ?? [];
    rows.push({ at: record.updatedAt, outcome });
    perRepo.set(record.repo, rows);
  }
  const repos: FleetCanaryLadderRepoInput[] = [...perRepo.entries()]
    .map(([repo, rows]) => ({
      repo,
      outcomes: rows
        .sort((left, right) => left.at.localeCompare(right.at))
        .map((row) => row.outcome),
    }))
    .sort((left, right) => left.repo.localeCompare(right.repo));
  const state = corrupt > 0 ? 'degraded' : records === 0 ? 'missing' : 'healthy';
  return { state, complete: corrupt === 0, records, corrupt, repos };
}

function formatNext(next: FleetCanaryLadderNext): string {
  if (next.event === null) return next.reason === 'no-evidence' ? 'none (no evidence)' : 'none (ladder ceiling)';
  return next.applies ? next.event : `${next.event} (refused: ${next.reason ?? 'unknown'})`;
}

export async function cmdFleetCanaryLadder(
  args: string[],
  deps: FleetCanaryLadderDeps = {},
): Promise<number> {
  const output = deps.output ?? ((text: string) => process.stdout.write(`${text}\n`));
  let json = false;
  for (const arg of args) {
    if ((arg === '--help' || arg === '-h') && args.length === 1) {
      output(`${FLEET_CANARY_LADDER_USAGE}\n` +
        'Read-only: reports the rung each repo\'s recent merge outcomes compute on the\n' +
        'canary enforce ladder, the evidence replayed, and the next transition a held\n' +
        'merge would attempt. Changes no gate, label, ruleset or merge setting.');
      return 0;
    }
    if (arg === '--json' && !json) {
      json = true;
      continue;
    }
    process.stderr.write(`error: invalid fleet canary-ladder argument: ${arg}\nusage: ${FLEET_CANARY_LADDER_USAGE}\n`);
    return 2;
  }
  const source = (deps.read ?? readFleetMergeOutcomeSource)();
  const report = projectFleetCanaryLadder(source, deps.now?.() ?? new Date());
  if (json) {
    output(JSON.stringify(report));
  } else {
    const lines = [`fleet canary-ladder: ${report.repos.length} repo(s), source ${source.state}`];
    for (const row of report.repos) {
      lines.push(`  ${row.repo}  rung=${row.rung}  evidence=${row.evidence}  next=${formatNext(row.nextStep)}`);
    }
    output(lines.join('\n'));
  }
  return source.state === 'degraded' ? 1 : 0;
}
