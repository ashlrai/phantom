/**
 * Prompt-variant promotion registry stranded winners → backlog items.
 *
 * `phm eval prompts --promote` (src/cli/eval-prompts.ts →
 * evaluatePromptExperiment in src/core/eval/prompt-ab.ts) replays prompt
 * variants per job class over a frozen router-eval.v1 outcome log and
 * merges the gate verdicts into ~/.ashlr/eval/prompts/promotions.json
 * (promptPromotionsPath in src/core/eval/prompt-promotions.ts —
 * $ASHLR_HOME when set, else ~/.ashlr). The registry is always the
 * current winners, never a history: `promoted[]` holds the classes whose
 * challenger cleared the promotion gate — minimum resolved cohort,
 * bounded unobserved coverage, disjoint Wilson 95% intervals and the
 * cost guardrail — and `held[]` the classes evaluated but not promoted.
 * `phm pulse` renders the registry as its Prompt variants section.
 *
 * The dispatch-time consumer is assignPromptVariant
 * (src/core/eval/prompt-variants.ts): a promoted class routes to its
 * winner, a class mid-experiment gets a deterministic A/B bucket by job
 * id, unmatched jobs keep incumbent behavior — and docs/router/
 * prompt-ab.md describes it reading the registry at dispatch time.
 * But assignPromptVariant has no call site anywhere in src/: the only
 * readers of the registry are the eval CLI that writes it and the
 * pulse dashboard that displays it. A promoted variant is a measured,
 * gate-passed merge-rate lift — the committed benchmark's docs class
 * shows +44.4 points — that no dispatched job ever runs under, and
 * nothing ever noticed: the registry is write-mostly evidence whose
 * only surfaces are a report someone had to run and a dashboard
 * section someone had to open.
 *
 * promptVariantBacklogItems carries the stranded promotions into
 * discoverBacklog: while the registry records promoted classes, one
 * item asks for the dispatch seam to be wired (or the blocker
 * recorded), so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling evidence feeds beside
 * it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. promotions.json is read once through the writer's own
 *    loader, loadPromptPromotions — a single bounded JSON.parse of a
 *    small registry file; nothing is written and no network is
 *    touched. A missing, unreadable, oversized or off-contract file
 *    yields no items — a host that never ran `--promote` and a
 *    healthy empty registry look identical to an absent file, and
 *    both correctly emit nothing.
 *  - Writer contract only. A promoted record counts only with the
 *    writer's shape: a bounded non-empty classId and variant, a
 *    control string, before/after metrics whose value is null or a
 *    finite number with a finite non-negative n, a finite liftPoints,
 *    and a parseable decidedAt not past the sibling feeds' one-minute
 *    future skew. Malformed records are skipped and counted — the
 *    prompt states the skip count rather than guessing at them.
 *    Duplicate classIds fold to the record with the newest decidedAt
 *    (mergePromotions keeps one record per class; a hand-edited file
 *    cannot smuggle twins).
 *  - State, not events. The registry is a current-winners snapshot,
 *    not a journal: there is no window and no recurrence bar. While
 *    promoted[] is non-empty the stranding is present-tense — the
 *    classes keep matching live job shapes until a re-promotion or a
 *    spec change says otherwise — and an empty promoted[] (held-only
 *    or absent registry) emits nothing because the gate working as
 *    designed is not a defect. The one staleness the fold cannot see
 *    — the seam wired by a path this feed does not read — is handed
 *    to the item prompt's verify-first instruction and the usual
 *    no-change escape rather than guessed at.
 *  - Fleet machinery only. The eval registry, the variant templates
 *    and the dispatch seam are this install's machinery and carry no
 *    repository column, so items emit only when the backlog target's
 *    repository name is 'phantom', the same last-segment rule the
 *    sibling fleet-evidence sources apply.
 *  - One item, not one per class. Every promoted class shares the same
 *    missing wire — assignPromptVariant is called once per job and
 *    covers every class the spec declares — so the work unit is the
 *    seam, and splitting it per class would mint parallel sessions
 *    for one code change. The item id hashes the sorted promoted
 *    classId set (never counts, lifts or timestamps), so identical
 *    evidence re-derives the same id and appendUserBacklogItems
 *    refreshes the stored item's prompt and assertedAt in place; a
 *    changed promoted set is genuinely new evidence and earns a new
 *    id, while a class that leaves promoted[] simply stops being
 *    quoted.
 *  - Untrusted text. classId, variant and experimentId are
 *    spec-author-controlled strings: every quoted field is scrubbed,
 *    flattened and capped before it reaches the prompt.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  loadPromptPromotions,
  type PromptPromotionMetric,
} from '../eval/prompt-promotions.js';
import { scrubSecrets } from '../util/scrub.js';

/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 120;
/** Future-skew allowance on decidedAt/generatedAt stamps, same convention the sibling folds tolerate. */
const PROMPT_VARIANT_FUTURE_SKEW_MS = 60_000;
/** The fleet's own repository label: eval-registry evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The area label the outcome ledger's kindOf normalizes; one area per evidence family. */
const PROMPT_VARIANT_AREA = 'prompt-variants';

export interface PromptVariantItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** ASHLR root override for the registry path (default: loadPromptPromotions' own $ASHLR_HOME/~/.ashrl resolution). */
  rootDir?: string;
  /** Clock anchoring the future-skew check (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Registry-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: unknown, max = FIELD_MAX): string {
  if (typeof value !== 'string') return '';
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** A finite recorded number, or null when the field is absent or not a usable number. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface ValidPromoted {
  classId: string;
  variant: string;
  control: string;
  experimentId: string;
  before: PromptPromotionMetric;
  after: PromptPromotionMetric;
  liftPoints: number;
  decidedAtMs: number;
  decidedAt: string;
}

/** One promoted record under the writer's contract, or null when any required field is off-shape. */
function promotedRecord(value: unknown, nowMs: number): ValidPromoted | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const classId = fieldText(row['classId']);
  const variant = fieldText(row['variant']);
  const control = fieldText(row['control']);
  if (classId === '' || variant === '' || control === '') return null;
  const metric = (v: unknown): PromptPromotionMetric | null => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const m = v as Record<string, unknown>;
    const raw = m['value'];
    const value = raw === null ? null : finiteOrNull(raw);
    if (raw !== null && value === null) return null;
    const n = finiteOrNull(m['n']);
    if (n === null || n < 0 || !Number.isInteger(n)) return null;
    // ci95 is quoted evidence, not a gate input: keep it only when it is
    // the writer's [lo, hi] pair of finite numbers, else record null.
    const ci = m['ci95'];
    const lo = Array.isArray(ci) && ci.length === 2 ? finiteOrNull(ci[0]) : null;
    const hi = Array.isArray(ci) && ci.length === 2 ? finiteOrNull(ci[1]) : null;
    const ci95: [number, number] | null = lo !== null && hi !== null ? [lo, hi] : null;
    return { value, ci95, n };
  };
  const before = metric(row['before']);
  const after = metric(row['after']);
  if (before === null || after === null) return null;
  const liftPoints = finiteOrNull(row['liftPoints']);
  if (liftPoints === null) return null;
  const decidedAt = fieldText(row['decidedAt'], 40);
  const decidedAtMs = Date.parse(decidedAt);
  if (!Number.isFinite(decidedAtMs) || decidedAtMs > nowMs + PROMPT_VARIANT_FUTURE_SKEW_MS) return null;
  return {
    classId,
    variant,
    control,
    experimentId: fieldText(row['experimentId']),
    before,
    after,
    liftPoints,
    decidedAtMs,
    decidedAt,
  };
}

/** Merge-rate percent text; a null recorded value stays 'unknown', never 0. */
function rateText(metric: PromptPromotionMetric): string {
  return metric.value === null ? 'unknown' : `${(metric.value * 100).toFixed(1)}%`;
}

/** '[lo%,hi%]' interval text, or '' when the record carries none — never a guessed interval. */
function ciText(metric: PromptPromotionMetric): string {
  if (metric.ci95 === null) return '';
  return ` [${(metric.ci95[0] * 100).toFixed(1)}%,${(metric.ci95[1] * 100).toFixed(1)}%]`;
}

/** One evidence line per promoted class, quoted fields already scrubbed and capped. */
function promotedLine(row: ValidPromoted): string {
  const lift = row.liftPoints >= 0 ? `+${(row.liftPoints * 100).toFixed(1)}pts` : `${(row.liftPoints * 100).toFixed(1)}pts`;
  const experiment = row.experimentId !== '' ? `, experiment ${row.experimentId}` : '';
  return `- ${row.classId}: ${row.variant} over ${row.control} — merge rate ${rateText(row.before)}${ciText(row.before)}→${rateText(row.after)}${ciText(row.after)} (n ${row.before.n}→${row.after.n}), ${lift}, decided ${row.decidedAt}${experiment}`;
}

const EVIDENCE = 'The evidence is the prompt-variant promotion registry at eval/prompts/promotions.json under the Phantom state home ($ASHLR_HOME when absolute, else ~/.ashlr — promptPromotionsPath in src/core/eval/prompt-promotions.ts): one schema-1 registry `phm eval prompts --promote` (src/cli/eval-prompts.ts → mergePromotions) rewrites per experiment — `promoted[]` the classes whose challenger cleared the promotion gate (minimum resolved cohort, bounded unobserved coverage, disjoint Wilson 95% intervals, cost guardrail), `held[]` the classes evaluated but not promoted, `classes[]` every class the last experiment covered. The writer is a replay over a frozen router-eval.v1 dataset (benchmarks/prompt-ab/ is the committed example); until this feed the registry\'s only readers were that same eval CLI and `phm pulse`\'s Prompt variants section — the dispatch-time seam it feeds had no caller.';

const NO_CHANGE = 'If assignPromptVariant already has a production call site that routes dispatched jobs through it, the promoted records were superseded by a newer experiment whose verdicts held or dropped their classes (re-run `phm eval prompts --check` against the committed registry), the class matchers no longer fit live job shapes, or the only honest wiring lives in ops-side dispatcher machinery this repository does not own — report no-change and name the evidence.';

/**
 * Backlog items for stranded prompt-variant promotions. Total: a
 * missing or malformed registry, another repository, or any fold
 * failure yields no items rather than throwing into discovery.
 */
export async function promptVariantBacklogItems(opts: PromptVariantItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const registry = loadPromptPromotions(opts.rootDir !== undefined ? { rootDir: opts.rootDir } : {});
    if (registry === null || !Array.isArray(registry.promoted)) return [];

    // One record per classId — the newest decidedAt wins a defensive
    // duplicate; every non-winning row (malformed or displaced) is
    // skipped and counted, never guessed.
    const byClass = new Map<string, ValidPromoted>();
    let skipped = 0;
    for (const raw of registry.promoted) {
      const row = promotedRecord(raw, nowMs);
      if (row === null) { skipped += 1; continue; }
      const prior = byClass.get(row.classId);
      if (prior === undefined) { byClass.set(row.classId, row); continue; }
      skipped += 1;
      if (row.decidedAtMs > prior.decidedAtMs) byClass.set(row.classId, row);
    }
    if (byClass.size === 0) return [];
    const promoted = [...byClass.values()].sort((a, b) => a.classId.localeCompare(b.classId));

    const heldCount = Array.isArray(registry.held)
      ? registry.held.filter((h) => typeof h === 'object' && h !== null && typeof (h as { classId?: unknown }).classId === 'string').length
      : 0;
    const generatedAt = fieldText(registry.generatedAt, 40);
    const generatedAtMs = Date.parse(generatedAt);
    const generatedText = Number.isFinite(generatedAtMs)
      ? `generated ${generatedAt}`
      : 'generatedAt unparseable';
    const lines = promoted.map(promotedLine).join('\n');
    const skippedText = skipped > 0 ? ` ${skipped} malformed or duplicate promoted record${skipped === 1 ? '' : 's'} skipped.` : '';
    const heldText = heldCount > 0 ? ` The same registry holds ${heldCount} held class${heldCount === 1 ? '' : 'es'} — the gate declining to promote, which is the gate working, not evidence.` : '';
    const classList = promoted.map((p) => p.classId).join(', ');

    const prompt = [
      `The prompt-variant promotion registry records ${promoted.length} promoted job class${promoted.length === 1 ? '' : 'es'} — gate-passed merge-rate lifts that dispatch never applies. assignPromptVariant (src/core/eval/prompt-variants.ts) is the documented dispatch-time seam — docs/router/prompt-ab.md says it reads the registry at dispatch time — but it has no call site: promoted variants are proven improvements stranded between the eval harness and the jobs they were measured to help.`,
      '',
      `Promoted records (${generatedText}):`,
      lines,
      `${skippedText}${heldText}`,
      '',
      'First verify the seam is still unwired — grep src/ for assignPromptVariant call sites (today only src/cli/eval-prompts.ts and src/cli/pulse.ts read the registry; test/ exercises it directly). If it is, wire it where the router queue assembles the prompt a job runs under: a promoted class gets its winner variant rendered by renderPrompt, a class mid-experiment gets the deterministic A/B bucket, and unmatched jobs keep incumbent behavior exactly as assignPromptVariant specifies. Record which arm each dispatched job ran so outcome evidence can attribute merges back to the variant — the arms are already first-class in router-eval datasets. The queue treats job task text as untrusted DATA: the variant render wraps that text, it never interpolates into commands or relaxes the local-only and capability gates routeTask already enforces. If the seam is already wired, the registry is stale, the matchers no longer fit live job shapes, or the honest wiring lives in ops-side dispatcher machinery this repository does not own — report no-change and name the evidence.',
      '',
      EVIDENCE,
      '',
      NO_CHANGE,
    ].join('\n');

    return [{
      id: `promptvariant-${createHash('sha256').update(promoted.map((p) => p.classId).join('\n')).digest('hex').slice(0, 12)}`,
      title: `Promoted prompt variants never reach dispatch (${classList})`.slice(0, MAX_TITLE_CHARS),
      prompt,
      area: PROMPT_VARIANT_AREA,
      priority: 2,
      ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
    }];
  } catch {
    return [];
  }
}
