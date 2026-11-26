/**
 * Learned-skill evidence ledgers → self-improvement backlog items.
 *
 * Phantom's learned-skill machinery stands on two append-only metadata
 * ledgers under the Ashlr home: the signed skill-card corpus
 * (~/.ashlr/skills/cards dated jsonl, read complete-bounded by
 * readSkillCardCorpus in src/core/fleet/skill-records.ts) and the
 * skill-use event ledger (~/.ashlr/skills/uses dated jsonl, read
 * bounded-windowed by readSkillUseEventsWithDiagnostics). Every
 * downstream consumer already treats their diagnostics as verdicts:
 * `phm fleet status` folds them into skillCorpusReadiness
 * (corpus.state 'degraded' on an unreadable/invalid/over-limit read or
 * on conflicting current revisions, learning.state
 * 'blocked-corpus-degraded') and into learningMetrics' skill-use source
 * availability; `phm skills list` prints the corpus state;
 * readSkillTrajectoryOutcomes (src/core/fleet/skill-outcomes.ts) returns
 * null — withholding every per-skill outcome tally — whenever the
 * use-event read reports eventState 'degraded'; and
 * skillOutcomeBacklogItems deliberately emits nothing while the corpus
 * read is not 'healthy', because partially corrupt card history cannot
 * prove which revision is live.
 *
 * Until now those verdicts only ever reached reports someone had to run
 * and read. A degraded card corpus silently emptied the verified
 * selection set — retrieval quarantines what it cannot trust, the
 * outcome join cannot prove live revisions, and the nudge/distillation
 * writers keep appending into a ledger nobody can read. A degraded
 * use-event ledger was worse: the trajectory join reads the
 * non-diagnostic readSkillUseEvents variant, so a truncated, corrupt or
 * conflicting event stream folded into skillObservation as quietly
 * fewer events — the failed-join cells of trajectoryGapBacklogItems
 * only count events that were read, never the ones the bounded read
 * never saw — while readSkillTrajectoryOutcomes withheld the whole
 * skillOutcomes projection and skillOutcomeBacklogItems went silent
 * with no item saying why. Both degradations are exactly the kind of
 * evidence-capture failure this backlog exists to turn into work.
 *
 * skillEvidenceBacklogItems carries the same recorded diagnostics into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling trajectory-gap and
 * skill-outcome sources beside them.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The corpus read is the same complete bounded read
 *    readSkillCardCorpus performs (snapshot-verified, fail-closed);
 *    the use-event read is the same bounded windowed read
 *    readSkillTrajectoryOutcomes applies as its publish gate, with the
 *    same sinceMs/limit/maxFiles derivation so the health gate and
 *    this feed see the same snapshot parameters. Nothing is written
 *    and no network is touched; any read failure degrades the
 *    affected result inside its own contract rather than throwing
 *    here.
 *  - Recorded verdicts only. The 'cards' cell emits on the corpus
 *    read's own sourceState 'degraded' — unreadable partitions,
 *    invalid rows, an exceeded bound or an unstable snapshot, all
 *    already collapsed to that verdict by the fail-closed reader —
 *    and quotes only the counters the result recorded. 'missing' is
 *    the clean empty state of a fresh install and never emits.
 *  - Conflicts are a separate recorded verdict. A 'healthy' corpus
 *    whose inspectVerifiedSkillCorpus fold finds skills whose newest
 *    revision carries more than one distinct fingerprint emits the
 *    'cards-conflict' cell: those skills are quarantined out of the
 *    current-revision set, invisible to listing, retrieval and outcome
 *    attribution. The conflict count is quoted as recorded; the
 *    inspection is pure over the cards the healthy read returned, so
 *    a degraded read never produces a conflict cell (its cards list
 *    is empty by contract).
 *  - The 'uses' cell emits on the use-event read's own eventState
 *    'degraded' — the union of an unhealthy source read, a replay
 *    conflict (one eventId recorded with different fingerprints) and
 *    a distinct-event count past the read limit — quoting the
 *    recorded sourceState/sourcePresent and the bounded event count.
 *    'none'/'present' never emit: an empty window or a clean read is
 *    not evidence.
 *  - Fleet machinery only. The skill ledgers describe this install's
 *    learned memory, so items emit only for the fleet's own
 *    repository ('phantom' last-segment match, the same rule the
 *    skill-outcome and trajectory-gap feeds apply).
 *  - Dedup is downstream. The item id hashes only the cell identity
 *    (cards / cards-conflict / uses — never the counters or
 *    timestamps), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; shifted counts do
 *    not spawn twin items, and a ledger that recovers simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counters are
 *    quoted only as recorded, the brief names the ledgers, the reader
 *    functions, the report commands and where the fix surfaces live,
 *    with the usual no-change escape — including the owner-only case
 *    of repairing the host-signed ledger files themselves.
 */
import { createHash } from 'node:crypto';

import { trajectoryWindowMaxFiles } from '../autonomy/trajectory-records.js';
import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  readSkillCardCorpus,
  readSkillUseEventsWithDiagnostics,
  type SkillCardCorpusReadResult,
  type SkillUseEventReadResult,
} from '../fleet/skill-records.js';
import { inspectVerifiedSkillCorpus } from '../fleet/skill-retrieval.js';

/** Items one call may emit; the cell set is bounded at three. */
export const SKILL_EVIDENCE_MAX_ITEMS = 8;
const SKILL_EVIDENCE_ITEM_HARD_MAX = 25;
/**
 * Evidence window for the use-event gate read: seven days, the same
 * recurrence window the sibling skill feeds anchor on — and the same
 * windowHours readSkillTrajectoryOutcomes is called with by
 * skillOutcomeBacklogItems, so this feed measures the gate the outcome
 * source actually applies.
 */
export const SKILL_EVIDENCE_WINDOW_HOURS = 24 * 7;
/** Trajectory cohort cap forwarded into the use-event read's limit derivation. */
export const SKILL_EVIDENCE_RECORD_LIMIT = 500;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: skill evidence is this repo's machinery. */
const FLEET_REPO_NAME = 'phantom';

export interface SkillEvidenceItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Evidence window in hours (default SKILL_EVIDENCE_WINDOW_HOURS); forwarded to the real use-event read. */
  windowHours?: number;
  /** Trajectory cohort cap forwarded into the use-event read's limit derivation (default SKILL_EVIDENCE_RECORD_LIMIT). */
  recordLimit?: number;
  /** Most items one call emits (default SKILL_EVIDENCE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the use-event window (default: now). */
  now?: Date;
  /**
   * Injected card-corpus read (tests); skips the corpus read when set.
   * Same contract as readSkillCardCorpus.
   */
  corpus?: SkillCardCorpusReadResult;
  /**
   * Injected use-event read (tests); skips the ledger read when set.
   * Same contract as readSkillUseEventsWithDiagnostics.
   */
  useEvents?: SkillUseEventReadResult;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const NO_CHANGE = 'If the window has rolled forward, the ledger read has since returned healthy (a transient mid-write or a since-repaired partition), the degraded verdict traces to deliberate operator state or an owner-only cause (host-signed ledger repair, host permissions on ~/.ashlr), or this checkout is not the fleet repository the ledgers describe — report no-change and name the evidence.';

const CORPUS_EVIDENCE = 'The evidence is the skill-card corpus read itself: readSkillCardCorpus (src/core/fleet/skill-records.ts) performs the complete bounded, snapshot-verified read of ~/.ashlr/skills/cards dated jsonl partitions that `phm skills list` and the fleet status skillCorpusReadiness projection share, and inspectVerifiedSkillCorpus (src/core/fleet/skill-retrieval.ts) folds the returned cards into the current-revision set.';

const USES_EVIDENCE = 'The evidence is the skill-use event read itself: readSkillUseEventsWithDiagnostics (src/core/fleet/skill-records.ts) performs the bounded windowed read of ~/.ashlr/skills/uses dated jsonl partitions — the same gate readSkillTrajectoryOutcomes (src/core/fleet/skill-outcomes.ts) applies before publishing trajectoryLearning.skillOutcomes, with the same sinceMs/limit/maxFiles derivation — and `phm fleet status --json` exposes the same sourceState/eventState through its learningMetrics skill-use source.';

interface Cell {
  key: string;
  title: string;
  prompt: string;
}

function cardsCell(corpus: SkillCardCorpusReadResult): Cell {
  const detail = [
    corpus.unreadableFiles > 0 ? `${corpus.unreadableFiles} unreadable file(s)` : '',
    corpus.invalidRows > 0 ? `${corpus.invalidRows} invalid row(s)/partition(s)` : '',
    corpus.limitExceeded ? 'read bound exceeded' : '',
  ].filter((part) => part !== '').join(', ');
  return {
    key: 'cards',
    title: `Learned-skill card corpus read degraded (${detail === '' ? 'unstable snapshot' : detail})`,
    prompt: [
      `Phantom's learned-skill card corpus read reported degraded: the complete bounded read of ~/.ashlr/skills/cards scanned ${corpus.filesScanned} partition(s)${corpus.sourcePresent ? '' : ' (the ledger root itself is absent or unreadable)'} and recorded ${corpus.unreadableFiles} unreadable file(s), ${corpus.invalidRows} invalid row(s)/partition(s)${corpus.limitExceeded ? ' and exceeded its read bound' : ''} — on degraded the fail-closed reader returns zero cards, so the whole learned-skills surface goes dark at once.`,
      '',
      `While the corpus reads degraded: \`phm skills list\` reports corpus degraded, \`phm fleet status --json\` shows skillCorpusReadiness.corpus.state 'degraded' with learning.state 'blocked-corpus-degraded', verified-skill retrieval (src/core/fleet/skill-retrieval.ts) selects nothing, readSkillTrajectoryOutcomes cannot prove live revisions and skillOutcomeBacklogItems withholds every per-skill outcome item — yet the writers (learnFromApplied in src/core/fleet/skill-library.ts, the nudge drafts in src/core/fleet/skill-nudge.ts) keep appending into a ledger nobody can read.`,
      '',
      `${CORPUS_EVIDENCE} The reader's degraded verdict covers unreadable partitions (permissions/ownership/snapshot instability — it requires private modes, current-user ownership and no-follow opens), invalid rows (lines the isSkillCard guard rejects — schema drift between writer and reader), an exceeded bound (MAX_COMPLETE_CORPUS_BYTES 16 MiB, MAX_COMPLETE_CORPUS_FILES 512, MAX_COMPLETE_CORPUS_ROWS 20000, MAX_COMPLETE_CORPUS_DIRECTORY_ENTRIES 2048 in skill-records.ts) or a thrown read.`,
      '',
      'Find out which diagnostic fired and why: check the newest ~/.ashlr/skills/cards partitions for corrupt or schema-drifted lines, files that changed mid-read, or a corpus that outgrew the complete-read bounds; fix the reader bounds, the writer schema or the partition naming in this repository\'s src/ where the cause lives. Skill cards are host-signed ledger records — repairing the ledger files themselves is owner-only. ' + NO_CHANGE,
    ].join('\n'),
  };
}

function cardsConflictCell(conflicting: number, considered: number, eligible: number): Cell {
  return {
    key: 'cards-conflict',
    title: `Learned-skill corpus has ${conflicting} conflicting card revision(s)`,
    prompt: [
      `Phantom's learned-skill card corpus read healthy but its current-revision fold found ${conflicting} skill(s) whose newest revision was recorded with more than one distinct fingerprint — the same (skillId, revision) carrying different content — out of ${considered} considered card(s) (${eligible} still eligible).`,
      '',
      `inspectCurrentCards (src/core/fleet/skill-retrieval.ts) quarantines every conflicting skill: it never enters the latest-revision set, so \`phm skills list\` never shows it, verified-skill retrieval never selects it and trajectory outcome attribution never credits it — a silently dead card that only \`phm fleet status --json\`'s skillCorpusReadiness reports as corpus degraded.`,
      '',
      `${CORPUS_EVIDENCE} The conflict signature means two writers stamped the same skillId+revision with different card content — check the card writers (learnFromApplied in src/core/fleet/skill-library.ts, the imported candidate drafts in src/core/fleet/skill-nudge.ts, manual/imported sources) for a revision-allocation race or an identity collision, and the ledger partitions under ~/.ashlr/skills/cards for the duplicated revision rows.`,
      '',
      'Find out which skills conflict and which writer produced the ambiguous revision; fix the writer or the revision allocation in this repository\'s src/. The card ledger is append-only and host-signed — rewriting or withdrawing the conflicting rows is owner-only, so if the right fix is a superseding revision or a ledger repair, report no-change and name the evidence. ' + NO_CHANGE,
    ].join('\n'),
  };
}

function usesCell(useEvents: SkillUseEventReadResult, windowHours: number): Cell {
  return {
    key: 'uses',
    title: 'Skill-use ledger read degraded — trajectory skill outcomes withheld',
    prompt: [
      `Phantom's skill-use event read reported eventState 'degraded' over the ${windowHours}-hour window: sourceState '${useEvents.sourceState}'${useEvents.sourcePresent ? '' : ' with no ledger root present'}, ${useEvents.events.length} event(s) returned by the bounded read — the same gate readSkillTrajectoryOutcomes applies before publishing trajectoryLearning.skillOutcomes.`,
      '',
      `The reader marks the read degraded on any of: an unhealthy partition scan (unreadable files, invalid rows the isSkillUseEvent guard rejects, a truncated tail), a replay conflict (one eventId recorded with different fingerprints), or more distinct events than the read limit — and every consumer degrades with it: readSkillTrajectoryOutcomes returns null so \`phm skills list --outcomes\` and skillOutcomeBacklogItems withhold all per-skill tallies; the trajectory join's non-diagnostic readSkillUseEvents folds whatever the bounded read returned, so trajectoryGapBacklogItems' failed-join cells only ever count events that were read, never the ones the degraded read never saw; and \`phm fleet status --json\` withholds the learningMetrics skill-use coverage.`,
      '',
      `${USES_EVIDENCE} The read covers ~/.ashlr/skills/uses dated jsonl partitions written by the shadow observer (src/core/fleet/skill-shadow-observer.ts) and the skill-use identity fold (src/core/fleet/skill-use-identity.ts).`,
      '',
      'Find out which diagnostic fired: check the windowed ~/.ashlr/skills/uses partitions for corrupt lines, permission or ownership drift, eventId conflicts between writers, or a volume that outgrew the bounded read (limit derived from the trajectory cohort cap, maxFiles from trajectoryWindowMaxFiles); fix the writer, the reader bounds or the retention in this repository\'s src/. Repairing the ledger files themselves is owner-only. ' + NO_CHANGE,
    ].join('\n'),
  };
}

function cellItem(cell: Cell, repo: string): CloudBacklogItem {
  const id = `skill-evidence-${createHash('sha256').update(`skill-evidence:${cell.key}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: cell.title.slice(0, MAX_TITLE_CHARS),
    prompt: cell.prompt,
    area: 'skill-evidence',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for learned-skill evidence-ledger degradation: the card
 * corpus's own read verdict, conflicting current revisions inside a
 * healthy corpus, and the use-event ledger's degraded bounded read.
 * Total: another repository, an injected or real read failure, or all
 * sources healthy yields no items rather than throwing into discovery.
 */
export async function skillEvidenceBacklogItems(opts: SkillEvidenceItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const windowHours = opts.windowHours ?? SKILL_EVIDENCE_WINDOW_HOURS;
    const corpus = opts.corpus ?? readSkillCardCorpus();
    const useEvents = opts.useEvents ?? readSkillUseEventsWithDiagnostics({
      sinceMs: (opts.now ?? new Date()).getTime() - windowHours * 60 * 60 * 1000,
      limit: Math.max((opts.recordLimit ?? SKILL_EVIDENCE_RECORD_LIMIT) * 8, 400),
      maxFiles: trajectoryWindowMaxFiles(windowHours),
    });

    const cells: Cell[] = [];
    if (corpus.sourceState === 'degraded') cells.push(cardsCell(corpus));
    else {
      const inspection = inspectVerifiedSkillCorpus(corpus.cards);
      if (inspection.conflicting > 0) {
        cells.push(cardsConflictCell(inspection.conflicting, inspection.considered, inspection.eligible));
      }
    }
    if (useEvents.eventState === 'degraded') cells.push(usesCell(useEvents, windowHours));

    const limit = Math.max(1, Math.min(opts.limit ?? SKILL_EVIDENCE_MAX_ITEMS, SKILL_EVIDENCE_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => cellItem(cell, repo));
  } catch {
    return [];
  }
}
