/**
 * Offline memory quality benchmark (protocol phantom-memory-benchmark-v2). Pure and deterministic:
 * no files, clock, providers, models or application state. It complements the 72-case conformance
 * corpus by measuring retrieval ranking, contradiction handling, temporal correctness, withdrawal,
 * context-pack token efficiency and multi-step task completion over authored synthetic histories.
 * "Task" means every step of a scripted session got the evidence it needed; no model executes a task.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/canonical-json.js';
import { buildMemoryContextPack } from '../memory/pack.js';
import { memoryScopeVisible } from '../memory/scope.js';
import { memoryUtf8Bytes } from '../memory/validate.js';
import type { MemoryContextPack, MemoryFactEvent, MemoryPackQuery, MemorySnapshot } from '../memory/types.js';
import { buildFlatLatestMemoryDiagnostic } from './memory-evaluation-baseline.js';
import { MEMORY_BENCHMARK_ABSENT_QUERIES, MEMORY_BENCHMARK_FACTS, type MemoryBenchmarkFact } from './memory-benchmark-catalog.js';

export const MEMORY_BENCHMARK_PROTOCOL = 'phantom-memory-benchmark-v2';
export const MEMORY_BENCHMARK_DIMENSIONS = ['retrieval', 'contradiction', 'temporal', 'withdrawal', 'task'] as const;
export type MemoryBenchmarkDimension = typeof MEMORY_BENCHMARK_DIMENSIONS[number];
export type MemoryBenchmarkDifficulty = 'lexical' | 'inflected' | 'paraphrase' | 'absent';
export interface MemoryBenchmarkExpectation {
  status?: MemoryContextPack['status'];
  /** Fact texts that must reach the model-facing pack text. */
  required: string[];
  /** Fact texts that must not reach it (stale, withdrawn, conflicting, deleted, foreign). */
  forbidden: string[];
  /** Same-scope slots with unresolved conflicts the pack should tell the reader about. */
  conflicts?: Array<{ subject: string; slot: string }>;
}
export interface MemoryBenchmarkStep { snapshot: MemorySnapshot; query: MemoryPackQuery; expect: MemoryBenchmarkExpectation }
export interface MemoryBenchmarkCase {
  id: string; dimension: MemoryBenchmarkDimension; difficulty?: MemoryBenchmarkDifficulty; why: string;
  /** Set when the expected outcome depends on an open owner decision; reported, never scored. */
  pendingDecision?: string;
  steps: MemoryBenchmarkStep[];
}

// ---- deterministic fixture builders ----
const PROJECT = 'project:phantom'; const OWNER = 'owner:operator'; const AUDIENCE = 'audience:agent';
export const benchDay = (day: number): string => new Date(Date.UTC(2026, 8, 1) + (day - 1) * 86_400_000).toISOString();
const NOW = benchDay(30);
const sha = (text: string): string => 'sha256_' + createHash('sha256').update(text, 'utf8').digest('hex');
interface EventSpec {
  id: string; subject: string; slot: string; text: string; fact?: string; revision?: number; kind?: 'fact' | 'tombstone';
  project?: string; owner?: string; audiences?: string[]; validFrom?: string | null; validUntil?: string | null; recordedAt?: string;
  review?: MemoryFactEvent['reviewState']; supersedes?: string[]; derivedFrom?: string[]; tombstones?: string[];
}
export function benchEvent(spec: EventSpec): MemoryFactEvent {
  const validFrom = spec.validFrom === undefined ? benchDay(1) : spec.validFrom;
  const recordedAt = spec.recordedAt ?? validFrom ?? benchDay(1);
  const reviewed = spec.review === undefined || spec.review === 'approved' || spec.review === 'withdrawn';
  const quote = spec.text || 'Reviewed deletion.';
  return { schemaVersion: 1, eventId: spec.id, factId: spec.fact ?? spec.id + ':fact', revision: spec.revision ?? 1, kind: spec.kind ?? 'fact',
    projectId: spec.project ?? PROJECT, ownerId: spec.owner ?? OWNER, audienceIds: spec.audiences ?? [AUDIENCE],
    subjectKey: spec.subject, slotKey: spec.slot, text: spec.text,
    sourceRefs: [{ id: spec.id + ':source', digest: sha(quote), locator: 'synthetic-turn:' + spec.id, quote, observedAt: recordedAt }],
    observedAt: recordedAt, validFrom, validUntil: spec.validUntil ?? null, recordedAt, reviewState: spec.review ?? 'approved',
    reviewedAt: reviewed ? recordedAt : null, reviewerDecisionId: reviewed ? spec.id + ':review' : null,
    supersedes: spec.supersedes ?? [], derivedFrom: spec.derivedFrom ?? [], tombstones: spec.tombstones ?? [], authority: false };
}
export function benchSnapshot(id: string, events: MemoryFactEvent[], recordedThrough = NOW): MemorySnapshot {
  return { schemaVersion: 1, snapshotId: id, revision: events.length, recordedThrough, sourceState: 'available', complete: true, events, authority: false };
}
interface QuerySpec { at?: string; mode?: 'current' | 'asOf'; knownAt?: string | null; maxFacts?: number; maxBytes?: number; project?: string; audience?: string }
export function benchQuery(text: string, spec: QuerySpec = {}): MemoryPackQuery {
  return { schemaVersion: 1, projectId: spec.project ?? PROJECT, ownerId: OWNER, audienceId: spec.audience ?? AUDIENCE,
    time: { mode: spec.mode ?? (spec.at ? 'asOf' : 'current'), at: spec.at ?? NOW }, knownAt: spec.knownAt ?? null,
    query: text, maxBytes: spec.maxBytes ?? 8192, maxFacts: spec.maxFacts ?? 3, authority: false };
}
const catalogEvent = (fact: MemoryBenchmarkFact, index: number, prefix = 'kb'): MemoryFactEvent =>
  benchEvent({ id: `${prefix}:${String(index + 1).padStart(2, '0')}`, subject: fact.subject, slot: fact.slot, text: fact.text });
const fact = (subject: string, slot: string): MemoryBenchmarkFact => {
  const found = MEMORY_BENCHMARK_FACTS.find(entry => entry.subject === subject && entry.slot === slot);
  if (!found) throw new Error('Unknown benchmark fact');
  return found;
};

// ---- case generation ----
function retrievalCases(): MemoryBenchmarkCase[] {
  // Every catalog fact plus look-alike facts from another project that must never be served.
  const foreign = MEMORY_BENCHMARK_FACTS.slice(0, 6).map((entry, index) => benchEvent({ id: `other:${index + 1}`, subject: entry.subject,
    slot: entry.slot, text: entry.text.replace(/\.$/, ' (other project).'), project: 'project:phantom-archive' }));
  const snapshot = benchSnapshot('retrieval', [...MEMORY_BENCHMARK_FACTS.map((entry, index) => catalogEvent(entry, index)), ...foreign]);
  const cases: MemoryBenchmarkCase[] = [];
  MEMORY_BENCHMARK_FACTS.forEach((entry, index) => {
    for (const difficulty of ['lexical', 'inflected', 'paraphrase'] as const) cases.push({ id: `retrieval:${index + 1}:${difficulty}`,
      dimension: 'retrieval', difficulty, why: `Find ${entry.subject}/${entry.slot} among ${MEMORY_BENCHMARK_FACTS.length} facts with a top-3 budget.`,
      steps: [{ snapshot, query: benchQuery(entry[difficulty]), expect: { required: [entry.text], forbidden: foreign.map(event => event.text) } }] });
  });
  MEMORY_BENCHMARK_ABSENT_QUERIES.forEach((text, index) => cases.push({ id: `retrieval:absent:${index + 1}`, dimension: 'retrieval', difficulty: 'absent',
    why: 'Nothing stored answers this; the pack should be empty rather than filler.',
    steps: [{ snapshot, query: benchQuery(text), expect: { status: 'none', required: [], forbidden: [] } }] }));
  return cases;
}
function contradictionCases(): MemoryBenchmarkCase[] {
  const target = fact('deploy', 'target'); const other = fact('test', 'command');
  const a = 'Deployment target is the staging cluster in us-east.'; const b = 'Deployment target is the canary cluster in eu-west.';
  const pair = (audiences?: string[]) => [benchEvent({ id: 'c:a', subject: 'deploy', slot: 'target', text: a }),
    benchEvent({ id: 'c:b', subject: 'deploy', slot: 'target', text: b, audiences, recordedAt: benchDay(2), validFrom: benchDay(2) })];
  const q = benchQuery(target.lexical);
  const conflict = [{ subject: 'deploy', slot: 'target' }];
  const one = (id: string, why: string, events: MemoryFactEvent[], expect: MemoryBenchmarkExpectation, query = q): MemoryBenchmarkCase =>
    ({ id: 'contradiction:' + id, dimension: 'contradiction', why, steps: [{ snapshot: benchSnapshot('contradiction:' + id, events), query, expect }] });
  return [
    one('same-slot', 'Two approved, overlapping claims in one slot: no silent winner.', pair(), { required: [], forbidden: [a, b], conflicts: conflict }),
    one('audience-overlap', 'Conflicting claims with different but overlapping audiences.', pair([AUDIENCE, 'audience:human']),
      { required: [], forbidden: [a, b], conflicts: conflict }),
    one('isolated', 'A conflict in one slot must not hide an unrelated fact requested in the same query.',
      [...pair(), benchEvent({ id: 'c:other', subject: 'test', slot: 'command', text: other.text })],
      { required: [other.text], forbidden: [a, b], conflicts: conflict }, benchQuery('deployment target and how to run unit tests', { maxFacts: 4 })),
    one('resolved', 'A reviewed correction superseding both sides resolves the conflict.',
      [...pair(), benchEvent({ id: 'c:fix', fact: 'c:a:fact', revision: 2, subject: 'deploy', slot: 'target', text: 'Deployment target is the production cluster in us-east.',
        validFrom: benchDay(3), supersedes: ['c:a', 'c:b'] })],
      // c:b belongs to another fact, so superseding it is a cross-fact replacement. Both sides must be gone.
      { required: ['Deployment target is the production cluster in us-east.'], forbidden: [a, b] }),
    one('agreement', 'Two facts that agree word for word are not a conflict.',
      [benchEvent({ id: 'c:a', subject: 'deploy', slot: 'target', text: a }), benchEvent({ id: 'c:dup', subject: 'deploy', slot: 'target', text: a, recordedAt: benchDay(2) })],
      { required: [a], forbidden: [] }),
    one('unreviewed-rival', 'A proposed rival claim is not admitted, so the approved claim stands.',
      [benchEvent({ id: 'c:a', subject: 'deploy', slot: 'target', text: a }), benchEvent({ id: 'c:b', subject: 'deploy', slot: 'target', text: b, review: 'proposed', recordedAt: benchDay(2) })],
      { required: [a], forbidden: [b] }),
    one('expired-rival', 'An expired claim does not conflict with the current one.',
      [benchEvent({ id: 'c:a', subject: 'deploy', slot: 'target', text: a, validFrom: benchDay(10) }),
        benchEvent({ id: 'c:b', subject: 'deploy', slot: 'target', text: b, validFrom: benchDay(1), validUntil: benchDay(10) })],
      { required: [a], forbidden: [b] }),
    one('foreign-rival', 'A rival claim in another project is out of scope, not a conflict.',
      [benchEvent({ id: 'c:a', subject: 'deploy', slot: 'target', text: a }), benchEvent({ id: 'c:b', subject: 'deploy', slot: 'target', text: b, project: 'project:other' })],
      { required: [a], forbidden: [b] }),
  ];
}
// Four reviewed revisions of one fact, each effective on its own day.
const CHAIN = ['Deployment target is the staging cluster in us-east.', 'Deployment target is the staging cluster in us-west.',
  'Deployment target is the production cluster in us-west.', 'Deployment target is the production cluster in eu-central.'];
const CHAIN_DAYS = [2, 8, 14, 20];
function chainEvents(): MemoryFactEvent[] {
  return CHAIN.map((text, index) => benchEvent({ id: `t:r${index + 1}`, fact: 't:fact', revision: index + 1, subject: 'deploy', slot: 'target', text,
    validFrom: benchDay(CHAIN_DAYS[index]!), supersedes: index ? [`t:r${index}`] : [] }));
}
function temporalCases(): MemoryBenchmarkCase[] {
  const q = fact('deploy', 'target').lexical;
  const only = (index: number): MemoryBenchmarkExpectation => ({ required: [CHAIN[index]!], forbidden: CHAIN.filter((_, i) => i !== index) });
  const one = (id: string, why: string, events: MemoryFactEvent[], query: MemoryPackQuery, expect: MemoryBenchmarkExpectation): MemoryBenchmarkCase =>
    ({ id: 'temporal:' + id, dimension: 'temporal', why, steps: [{ snapshot: benchSnapshot('temporal:' + id, events), query, expect }] });
  return [
    one('current', 'Current view serves the newest effective revision.', chainEvents(), benchQuery(q), only(3)),
    ...[1, 2].map(index => one(`as-of-${index + 1}`, 'A historical view inside an interval serves that interval\'s revision.', chainEvents(),
      benchQuery(q, { at: benchDay(CHAIN_DAYS[index]! + 3) }), only(index))),
    one('boundary-inclusive', 'validFrom is inclusive: at the exact effective instant the new revision applies.', chainEvents(),
      benchQuery(q, { at: benchDay(CHAIN_DAYS[2]!) }), only(2)),
    one('before-first', 'Before the first revision there is no answer.', chainEvents(), benchQuery(q, { at: benchDay(1) }),
      { status: 'none', required: [], forbidden: CHAIN }),
    one('known-at', 'A knowledge cutoff before the last correction was recorded serves what was known then.', chainEvents(),
      benchQuery(q, { knownAt: benchDay(15) }), only(2)),
    one('expiry-exclusive', 'validUntil is exclusive: a fact expiring now is not served.',
      [benchEvent({ id: 't:x', subject: 'deploy', slot: 'target', text: CHAIN[0]!, validUntil: benchDay(30) })],
      benchQuery(q), { status: 'none', required: [], forbidden: [CHAIN[0]!] }),
    one('future-correction', 'A reviewed correction effective next week does not replace today\'s value yet.',
      [...chainEvents(), benchEvent({ id: 't:r5', fact: 't:fact', revision: 5, subject: 'deploy', slot: 'target', text: 'Deployment target is the edge cluster.',
        validFrom: benchDay(35), recordedAt: benchDay(25), supersedes: ['t:r4'] })],
      benchQuery(q), { required: [CHAIN[3]!], forbidden: ['Deployment target is the edge cluster.', ...CHAIN.slice(0, 3)] }),
    one('delayed-import', 'An old observation imported late cannot override a newer reviewed value.',
      [...chainEvents(), benchEvent({ id: 't:late', subject: 'deploy', slot: 'target', text: 'Deployment target is the legacy cluster.',
        validFrom: benchDay(3), validUntil: benchDay(6), recordedAt: benchDay(28) })],
      benchQuery(q), only(3)),
    one('backdated-correction', 'A correction backdated before the value it replaces must not leave the stale value served.',
      [benchEvent({ id: 't:a', fact: 't:fact', subject: 'deploy', slot: 'target', text: CHAIN[0]!, validFrom: benchDay(10) }),
        benchEvent({ id: 't:b', fact: 't:fact', revision: 2, subject: 'deploy', slot: 'target', text: CHAIN[1]!, validFrom: benchDay(5), recordedAt: benchDay(12), supersedes: ['t:a'] })],
      benchQuery(q), { required: [], forbidden: [CHAIN[0]!] }),
  ];
}
function withdrawalCases(): MemoryBenchmarkCase[] {
  const entry = fact('deploy', 'target'); const q = entry.lexical; const text = entry.text;
  const base = benchEvent({ id: 'w:r1', fact: 'w:fact', subject: 'deploy', slot: 'target', text });
  const withdraw = (spec: Partial<EventSpec> = {}) => benchEvent({ id: 'w:r2', fact: 'w:fact', revision: 2, subject: 'deploy', slot: 'target', text,
    review: 'withdrawn', validFrom: benchDay(15), ...spec });
  const one = (id: string, why: string, events: MemoryFactEvent[], query: MemoryPackQuery, expect: MemoryBenchmarkExpectation, pendingDecision?: string): MemoryBenchmarkCase =>
    ({ id: 'withdrawal:' + id, dimension: 'withdrawal', why, pendingDecision, steps: [{ snapshot: benchSnapshot('withdrawal:' + id, events), query, expect }] });
  const replacement = 'Deployment target is the production cluster in us-west.';
  return [
    one('current', 'A reviewed withdrawal retires the fact with no fallback.', [base, withdraw()], benchQuery(q), { status: 'none', required: [], forbidden: [text] }),
    one('as-of-before', 'History before the withdrawal still shows the fact.', [base, withdraw()], benchQuery(q, { at: benchDay(10) }), { required: [text], forbidden: [] }),
    one('known-before', 'A knowledge cutoff before the withdrawal was recorded still shows the fact.', [base, withdraw()],
      benchQuery(q, { knownAt: benchDay(12) }), { required: [text], forbidden: [] }),
    one('reapproved', 'A newer reviewed revision after a withdrawal is served.',
      [base, withdraw(), benchEvent({ id: 'w:r3', fact: 'w:fact', revision: 3, subject: 'deploy', slot: 'target', text: replacement, validFrom: benchDay(20) })],
      benchQuery(q), { required: [replacement], forbidden: [text] }),
    one('future', 'A withdrawal effective in the future does not retire the fact today.', [base, withdraw({ validFrom: benchDay(40), recordedAt: benchDay(20) })],
      benchQuery(q), { required: [text], forbidden: [] }),
    one('unreviewed', 'A proposed withdrawal has no effect until reviewed.', [base, withdraw({ review: 'proposed' })], benchQuery(q), { required: [text], forbidden: [] }),
    one('other-fact', 'Withdrawing one fact leaves another fact in the same subject alone.',
      [base, withdraw(), benchEvent({ id: 'w:window', subject: 'deploy', slot: 'window', text: fact('deploy', 'window').text })],
      benchQuery('deployment target and when deploys are frozen'), { required: [fact('deploy', 'window').text], forbidden: [text] }),
    one('audience-mismatch', 'A visible reviewed withdrawal retires the fact even when its audience list differs (decided in #744).',
      [base, withdraw({ audiences: [AUDIENCE, 'audience:human'] })], benchQuery(q), { status: 'none', required: [], forbidden: [text] }),
  ];
}
function taskCases(): MemoryBenchmarkCase[] {
  const kb = (): MemoryFactEvent[] => MEMORY_BENCHMARK_FACTS.map((entry, index) => catalogEvent(entry, index));
  const idOf = (subject: string, slot: string): string => `kb:${String(MEMORY_BENCHMARK_FACTS.indexOf(fact(subject, slot)) + 1).padStart(2, '0')}`;
  const t = (subject: string, slot: string) => fact(subject, slot).text;
  const task = (id: string, why: string, steps: MemoryBenchmarkStep[]): MemoryBenchmarkCase => ({ id: 'task:' + id, dimension: 'task', why, steps });
  const step = (events: MemoryFactEvent[], query: MemoryPackQuery, expect: MemoryBenchmarkExpectation, through = NOW): MemoryBenchmarkStep =>
    ({ snapshot: benchSnapshot('task-step', events, through), query, expect });
  const newTest = 'Run unit tests with npm run test:ci -- --maxWorkers=2.';
  const fixTest = [...kb(), benchEvent({ id: 'task:test2', fact: idOf('test', 'command') + ':fact', revision: 2, subject: 'test', slot: 'command', text: newTest,
    validFrom: benchDay(31), recordedAt: benchDay(31), supersedes: [idOf('test', 'command')] })];
  const newDeploy = 'Deployment target is the production cluster in us-west.';
  const deployWithdrawn = [...kb(), benchEvent({ id: 'task:deploy-w', fact: idOf('deploy', 'target') + ':fact', revision: 2, subject: 'deploy', slot: 'target',
    text: t('deploy', 'target'), review: 'withdrawn', validFrom: benchDay(31), recordedAt: benchDay(31) })];
  const deployReplaced = [...deployWithdrawn, benchEvent({ id: 'task:deploy-3', fact: idOf('deploy', 'target') + ':fact', revision: 3, subject: 'deploy',
    slot: 'target', text: newDeploy, validFrom: benchDay(32), recordedAt: benchDay(32) })];
  const newDb = 'The primary database is postgres named phantom_core.';
  const dbMoved = [...kb(), benchEvent({ id: 'task:db-del', kind: 'tombstone', subject: 'database', slot: 'name', text: '', tombstones: [idOf('database', 'name')],
    validFrom: benchDay(31), recordedAt: benchDay(31) }), benchEvent({ id: 'task:db-2', subject: 'database', slot: 'name', text: newDb, validFrom: benchDay(31), recordedAt: benchDay(31) })];
  const rival = 'Releases are cut from the master branch.';
  const conflicted = [...kb(), benchEvent({ id: 'task:rival', subject: 'release', slot: 'branch', text: rival, recordedAt: benchDay(5), validFrom: benchDay(5) })];
  const archive = MEMORY_BENCHMARK_FACTS.map((entry, index) => benchEvent({ id: `arch:${index + 1}`, subject: entry.subject, slot: entry.slot,
    text: entry.text.replace(/\.$/, ' (archived service).'), project: 'project:phantom-archive' }));
  const later = benchDay(33);
  return [
    task('fix-ci', 'Fix a failing check, then pick up a reviewed change to the test command mid-task.', [
      step(kb(), benchQuery('how do I run unit tests and what does lint require', { maxFacts: 4 }), { required: [t('test', 'command'), t('lint', 'rule')], forbidden: [] }),
      step(fixTest, benchQuery('how do I run unit tests', { at: later }), { required: [newTest], forbidden: [t('test', 'command')] }, later),
      step(fixTest, benchQuery('which command runs the build and how do I run unit tests', { at: later, maxFacts: 4 }),
        { required: [newTest, t('build', 'command')], forbidden: [t('test', 'command')] }, later),
    ]),
    task('ship-release', 'Prepare a release while the deployment target is withdrawn and then replaced.', [
      step(kb(), benchQuery('which branch are releases cut from and who owns release approvals', { maxFacts: 4 }),
        { required: [t('release', 'branch'), t('release', 'approver')], forbidden: [] }),
      step(deployWithdrawn, benchQuery('what is the deployment target and when are deploys frozen', { at: benchDay(31), maxFacts: 4 }),
        { required: [t('deploy', 'window')], forbidden: [t('deploy', 'target')] }, benchDay(31)),
      step(deployReplaced, benchQuery('what is the deployment target', { at: later }), { required: [newDeploy], forbidden: [t('deploy', 'target')] }, later),
    ]),
    task('onboard', 'Answer a newcomer\'s broad question with five facts while one slot is contested.', [
      step(conflicted, benchQuery('how do I run unit tests, format rust code, which branch are releases cut from, where are secrets stored, and where are public docs published', { maxFacts: 6 }),
        { required: [t('test', 'command'), t('format', 'tool'), t('secrets', 'storage'), t('docs', 'site')], forbidden: [t('release', 'branch'), rival],
          conflicts: [{ subject: 'release', slot: 'branch' }] }),
    ]),
    task('migrate-db', 'Move to a new database name; the deleted name must not come back, even in history.', [
      step(dbMoved, benchQuery('what is the primary database name', { at: later }), { required: [newDb], forbidden: [t('database', 'name')] }, later),
      step(dbMoved, benchQuery('what is the primary database name', { at: benchDay(20) }), { required: [], forbidden: [t('database', 'name')] }, later),
    ]),
    task('audit', 'Compare last month\'s deployment target with today\'s.', [
      step(chainEvents(), benchQuery(fact('deploy', 'target').lexical, { at: benchDay(9) }), { required: [CHAIN[1]!], forbidden: [CHAIN[0]!, CHAIN[2]!, CHAIN[3]!] }),
      step(chainEvents(), benchQuery(fact('deploy', 'target').lexical), { required: [CHAIN[3]!], forbidden: CHAIN.slice(0, 3) }),
    ]),
    task('cross-project', 'Work in one project while a sibling project has look-alike facts.', [
      step([...kb(), ...archive], benchQuery('which command runs the build and where does CI run', { maxFacts: 4 }),
        { required: [t('build', 'command'), t('ci', 'runner')], forbidden: archive.map(event => event.text) }),
      step([...kb(), ...archive], benchQuery('where does CI run', { project: 'project:phantom-archive' }),
        { required: [archive[MEMORY_BENCHMARK_FACTS.indexOf(fact('ci', 'runner'))]!.text], forbidden: [t('ci', 'runner')] }),
    ]),
    task('tight-budget', 'Fit the two facts a step needs into a small context budget.', [
      step(kb(), benchQuery('how do I run unit tests and what does lint require', { maxFacts: 2, maxBytes: 1024 }),
        { required: [t('test', 'command'), t('lint', 'rule')], forbidden: [] }),
      step(kb(), benchQuery('which branch are releases cut from, who owns release approvals, and when are deploys frozen', { maxFacts: 3, maxBytes: 1280 }),
        { required: [t('release', 'branch'), t('release', 'approver'), t('deploy', 'window')], forbidden: [] }),
    ]),
    task('paraphrase', 'A teammate asks in their own words rather than the stored wording.', [
      step(kb(), benchQuery('how are builds produced for packages'), { required: [t('build', 'command')], forbidden: [] }),
      step(kb(), benchQuery('linting warning policy'), { required: [t('lint', 'rule')], forbidden: [] }),
    ]),
  ];
}
export function memoryBenchmarkCases(): MemoryBenchmarkCase[] {
  return [...retrievalCases(), ...contradictionCases(), ...temporalCases(), ...withdrawalCases(), ...taskCases()];
}

// ---- scoring ----
export type MemoryBenchmarkBuilder = (snapshot: unknown, query: unknown) => MemoryContextPack;
export interface MemoryBenchmarkStepResult {
  pass: boolean; failures: string[]; status: MemoryContextPack['status'];
  requiredFound: number; requiredTotal: number; firstRequiredRank: number | null; extraneousItems: number; forbiddenLeaks: number;
  conflictsSurfaced: number; conflictsTotal: number; packBytes: number; requiredTextBytes: number; receiptForeignEventIds: number;
}
export interface MemoryBenchmarkCaseResult {
  id: string; dimension: MemoryBenchmarkDimension; difficulty: MemoryBenchmarkDifficulty | null; pendingDecision: string | null;
  pass: boolean; steps: MemoryBenchmarkStepResult[];
}
export interface MemoryBenchmarkSummary {
  cases: number; passed: number; passRate: number; steps: number; stepsPassed: number;
  /** Retrieval: share of required facts present, rank-1 share and mean reciprocal rank over steps with required facts. */
  recall: number; hitAt1: number; mrr: number;
  extraneousPerStep: number; forbiddenLeaks: number; conflictsSurfaced: number; conflictsTotal: number;
  /** Bytes of required fact text divided by pack bytes, over passing ready steps. Higher is leaner. */
  payloadRatio: number | null; meanPackBytes: number; receiptForeignEventIds: number;
}
export interface MemoryBenchmarkArmReport {
  arm: string; overall: MemoryBenchmarkSummary;
  byDimension: Record<MemoryBenchmarkDimension, MemoryBenchmarkSummary>;
  retrievalByDifficulty: Record<MemoryBenchmarkDifficulty, MemoryBenchmarkSummary>;
  pendingDecisions: Array<{ id: string; question: string; observedStatus: string; servedForbidden: boolean }>;
  cases: MemoryBenchmarkCaseResult[];
}
export interface MemoryBenchmarkReport {
  schemaVersion: 1; protocol: typeof MEMORY_BENCHMARK_PROTOCOL; casesDigest: string; caseCount: number;
  modelTaskSuccess: 'not-evaluated'; authority: false; arms: MemoryBenchmarkArmReport[];
}
const quoted = (text: string): string => JSON.stringify(text).slice(1, -1).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
const round = (value: number): number => Math.round(value * 10_000) / 10_000;
function scoreStep(step: MemoryBenchmarkStep, builder: MemoryBenchmarkBuilder): MemoryBenchmarkStepResult {
  const inputs = JSON.parse(canonicalJson({ snapshot: step.snapshot, query: step.query })) as { snapshot: unknown; query: unknown };
  const pack = builder(inputs.snapshot, inputs.query);
  const failures: string[] = [];
  const has = (text: string): boolean => pack.text.includes(quoted(text));
  const byId = new Map(step.snapshot.events.map(event => [event.eventId, event]));
  const itemTexts = pack.items.map(item => byId.get(item.eventId)?.text ?? '');
  const required = step.expect.required; const found = required.filter(has);
  const ranks = itemTexts.map((text, index) => required.includes(text) ? index + 1 : 0).filter(Boolean);
  const leaks = step.expect.forbidden.filter(has).length;
  const conflicts = step.expect.conflicts ?? [];
  const lower = pack.text.toLowerCase();
  const surfaced = conflicts.filter(slot => lower.includes('conflict') && pack.text.includes(slot.subject) && pack.text.includes(slot.slot)).length;
  if (step.expect.status && pack.status !== step.expect.status) failures.push('status');
  if (found.length < required.length) failures.push('missing-required');
  if (leaks) failures.push('forbidden-text');
  if (pack.bytes > step.query.maxBytes || pack.items.length > step.query.maxFacts) failures.push('budget');
  return { pass: !failures.length, failures, status: pack.status, requiredFound: found.length, requiredTotal: required.length,
    firstRequiredRank: ranks.length ? Math.min(...ranks) : null, extraneousItems: itemTexts.filter(text => !required.includes(text)).length,
    forbiddenLeaks: leaks, conflictsSurfaced: surfaced, conflictsTotal: conflicts.length, packBytes: pack.bytes,
    requiredTextBytes: found.reduce((sum, text) => sum + memoryUtf8Bytes(text), 0),
    receiptForeignEventIds: pack.receipt.exclusions.filter(exclusion => {
      const event = byId.get(exclusion.eventId); return Boolean(event) && !memoryScopeVisible(event!, step.query);
    }).length };
}
function summarize(results: MemoryBenchmarkCaseResult[]): MemoryBenchmarkSummary {
  const scored = results.filter(result => !result.pendingDecision);
  const steps = scored.flatMap(result => result.steps);
  const withRequired = steps.filter(step => step.requiredTotal > 0);
  const lean = steps.filter(step => step.pass && step.status === 'ready' && step.requiredTotal > 0);
  const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
  const mean = (values: number[]): number => values.length ? round(sum(values) / values.length) : 0;
  return { cases: scored.length, passed: scored.filter(result => result.pass).length,
    passRate: scored.length ? round(scored.filter(result => result.pass).length / scored.length) : 0,
    steps: steps.length, stepsPassed: steps.filter(step => step.pass).length,
    recall: withRequired.length ? round(sum(withRequired.map(step => step.requiredFound)) / sum(withRequired.map(step => step.requiredTotal))) : 0,
    hitAt1: mean(withRequired.map(step => step.firstRequiredRank === 1 ? 1 : 0)),
    mrr: mean(withRequired.map(step => step.firstRequiredRank ? 1 / step.firstRequiredRank : 0)),
    extraneousPerStep: mean(steps.map(step => step.extraneousItems)), forbiddenLeaks: sum(steps.map(step => step.forbiddenLeaks)),
    conflictsSurfaced: sum(steps.map(step => step.conflictsSurfaced)), conflictsTotal: sum(steps.map(step => step.conflictsTotal)),
    payloadRatio: lean.length ? round(sum(lean.map(step => step.requiredTextBytes)) / sum(lean.map(step => step.packBytes))) : null,
    meanPackBytes: mean(steps.map(step => step.packBytes)), receiptForeignEventIds: sum(steps.map(step => step.receiptForeignEventIds)) };
}
export function runMemoryBenchmark(arms: Array<{ arm: string; builder: MemoryBenchmarkBuilder }> = [
  { arm: 'governed', builder: buildMemoryContextPack }, { arm: 'flat-latest-record-diagnostic', builder: buildFlatLatestMemoryDiagnostic }]): MemoryBenchmarkReport {
  const cases = memoryBenchmarkCases();
  const report: MemoryBenchmarkReport = { schemaVersion: 1, protocol: MEMORY_BENCHMARK_PROTOCOL,
    casesDigest: 'sha256_' + createHash('sha256').update(canonicalJson(cases), 'utf8').digest('hex'), caseCount: cases.length,
    modelTaskSuccess: 'not-evaluated', authority: false, arms: [] };
  for (const { arm, builder } of arms) {
    const results = cases.map((entry): MemoryBenchmarkCaseResult => {
      const steps = entry.steps.map(step => scoreStep(step, builder));
      return { id: entry.id, dimension: entry.dimension, difficulty: entry.difficulty ?? null, pendingDecision: entry.pendingDecision ?? null,
        pass: steps.every(step => step.pass), steps };
    });
    const pick = (filter: (result: MemoryBenchmarkCaseResult) => boolean) => summarize(results.filter(filter));
    report.arms.push({ arm, overall: pick(() => true),
      byDimension: Object.fromEntries(MEMORY_BENCHMARK_DIMENSIONS.map(dimension => [dimension, pick(result => result.dimension === dimension)])) as MemoryBenchmarkArmReport['byDimension'],
      retrievalByDifficulty: Object.fromEntries((['lexical', 'inflected', 'paraphrase', 'absent'] as const)
        .map(difficulty => [difficulty, pick(result => result.difficulty === difficulty)])) as MemoryBenchmarkArmReport['retrievalByDifficulty'],
      pendingDecisions: results.filter(result => result.pendingDecision).map(result => ({ id: result.id, question: result.pendingDecision!,
        observedStatus: result.steps.map(step => step.status).join(','), servedForbidden: result.steps.some(step => step.forbiddenLeaks > 0) })),
      cases: results });
  }
  return report;
}
