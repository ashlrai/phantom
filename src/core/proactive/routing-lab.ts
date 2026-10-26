/** Offline/shadow advisory lab. Never imports decide(), resolves a key, or contacts a provider.
 * Reuses resource-choice's closed ordinal set (255), 6000-character bound and 0.8
 * advisory gate. Jev confidence is distribution sharpness, not calibrated accuracy. */
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { companionDigest } from './coordination-types.js';
import { companionHash, companionObject, companionSafeText, companionTime, companionToken, validCompanionIdentity } from './coordination-store.js';
import { RoutingLabStore, ROUTING_LAB_LIMITS, routingLabEvaluationId, routingLabId, routingLabReference } from './routing-lab-store.js';
import type { ProactiveResourceEvidenceResponse, ProactiveResourceEvidenceRow } from './resource-evidence-types.js';
import type { OfflineChoiceAdapter, OfflineChoicePayload, RoutingLab, RoutingLabCandidate, RoutingLabCaseReceipt,
  RoutingLabCommand, RoutingLabEvaluation, RoutingLabOptions, RoutingLabTask } from './routing-lab-types.js';
export type * from './routing-lab-types.js';

const POLICY = 'companion-routing-lab-v1' as const;
const MODEL = 'jev-1.13.0' as const;
const THRESHOLD = 0.8;
const MAX_AGE_MS = 5 * 60_000;
function validTask(task: unknown): task is RoutingLabTask {
  if (!companionObject(task, ['taskId', 'tenantId', 'projectBindingId', 'packetDigest', 'capabilityIds', 'accountRefs', 'deadline', 'maxCostUsd'], ['allowedDestination'])) return false;
  const input = task as RoutingLabTask;
  return companionToken(input.taskId) && companionToken(input.tenantId) && companionToken(input.projectBindingId) && companionHash(input.packetDigest) &&
    Array.isArray(input.capabilityIds) && input.capabilityIds.length <= 64 && input.capabilityIds.every(companionToken) &&
    new Set(input.capabilityIds).size === input.capabilityIds.length && Array.isArray(input.accountRefs) && input.accountRefs.length <= 64 &&
    input.accountRefs.every(routingLabReference) && new Set(input.accountRefs).size === input.accountRefs.length &&
    (input.allowedDestination === undefined || validCompanionIdentity(input.allowedDestination)) && (input.deadline === null || companionTime(input.deadline)) &&
    (input.maxCostUsd === null || typeof input.maxCostUsd === 'number' && Number.isFinite(input.maxCostUsd) && input.maxCostUsd >= 0 && input.maxCostUsd <= 1_000_000);
}
function validCommand(command: unknown): command is RoutingLabCommand {
  if (!companionObject(command, ['kind', 'requestId', 'expectedRevision'], ['task', 'taskId', 'evaluationId', 'resourceId', 'reason', 'proposalId'])) return false;
  const input = command as RoutingLabCommand; const exact = (keys: string[]) => companionObject(command, ['kind', 'requestId', 'expectedRevision', ...keys]);
  if (!companionToken(input.requestId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return false;
  switch (input.kind) {
    case 'benchmark': return exact([]);
    case 'preview': return 'task' in input ? exact(['task']) && validTask(input.task) : exact(['taskId']) && companionToken(input.taskId);
    case 'propose-preference': return exact(['evaluationId', 'resourceId', 'reason']) && routingLabId(input.evaluationId) &&
      routingLabReference(input.resourceId) && companionSafeText(input.reason, 1000);
    case 'withdraw-preference': return exact(['proposalId']) && routingLabId(input.proposalId);
    default: return false;
  }
}
function missingSnapshot(at: string): ProactiveResourceEvidenceResponse {
  return { schemaVersion: 1, sampledAt: at, sourceState: 'missing', resources: [], executionAuthorized: false, notes: ['Read-only source snapshot is unavailable.'] };
}
function validSnapshot(snapshot: ProactiveResourceEvidenceResponse): boolean {
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.executionAuthorized !== false || !companionTime(snapshot.sampledAt) ||
    !['snapshot', 'missing', 'invalid'].includes(snapshot.sourceState) || !Array.isArray(snapshot.resources) || snapshot.resources.length > ROUTING_LAB_LIMITS.rows) return false;
  const ids = new Set<string>();
  return snapshot.resources.every(row => {
    if (!row || !routingLabReference(row.resourceId) || ids.has(row.resourceId) || !companionSafeText(row.label, 200) ||
      row.executionAuthorized !== false || !row.identity || !companionToken(row.identity.provider) ||
      !(row.identity.accountId === null || routingLabReference(row.identity.accountId)) ||
      !(row.identity.agentId === null || routingLabReference(row.identity.agentId)) ||
      !['native-subscription', 'api', 'local', 'personal-agent', 'funding-pool'].includes(row.kind) ||
      !['declared', 'observed-reference', 'unknown', 'conflict'].includes(row.identityState) ||
      !['configured', 'observed', 'signed-out', 'unavailable', 'unknown'].includes(row.connectionState) ||
      !['declared-unverified', 'adapter-reported', 'unknown'].includes(row.capabilityState) ||
      !['adapter-reported', 'blocked', 'unverified', 'unknown'].includes(row.readinessState) ||
      !['current', 'stale', 'missing', 'invalid', 'conflict'].includes(row.evidenceState) ||
      !(row.asOf === null || companionTime(row.asOf)) || !Array.isArray(row.capabilityIds) || row.capabilityIds.length > 64 ||
      !row.capabilityIds.every(companionToken) || !Array.isArray(row.usageWindows) || row.usageWindows.length > 64 ||
      row.usageWindows.some(window => !window || typeof window.limitReached !== 'boolean' ||
        window.usedPercent !== null && (!Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100)) ||
      !Array.isArray(row.credits) || row.credits.length > 64 || !row.cost ||
      !['actual', 'estimated', 'unknown'].includes(row.cost.state) ||
      !(row.cost.value === null || Number.isFinite(row.cost.value) && row.cost.value >= 0) ||
      !(row.cost.asOf === null || companionTime(row.cost.asOf))) return false;
    ids.add(row.resourceId); return true;
  });
}
function fresh(at: string | null, state: string, nowMs: number): boolean {
  const time = at === null ? NaN : Date.parse(at);
  return state === 'current' && Number.isFinite(time) && time <= nowMs && nowMs - time <= MAX_AGE_MS;
}
function candidates(task: RoutingLabTask, snapshot: ProactiveResourceEvidenceResponse, mode: 'fixture' | 'shadow-readonly', at: string): RoutingLabCandidate[] {
  const nowMs = Date.parse(at);
  return [...snapshot.resources].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0).map(row => {
    const holds: string[] = []; const matched = task.capabilityIds.filter(id => row.capabilityIds.includes(id));
    if (task.capabilityIds.length === 0) holds.push('requirements-unknown');
    if (row.kind === 'funding-pool') holds.push('funding-only-not-execution-resource');
    if (matched.length !== task.capabilityIds.length) holds.push('capability-mismatch');
    if (snapshot.sourceState !== 'snapshot') holds.push('source-missing');
    if (!fresh(row.asOf, row.evidenceState, nowMs)) holds.push('source-stale-or-unknown');
    if (!['declared', 'observed-reference'].includes(row.identityState)) holds.push('identity-unknown-or-conflicting');
    if (mode === 'fixture') {
      // Internal synthetic accountRefs form a fixture allowlist, never real destination admission.
      if (row.identity.accountId === null || !task.accountRefs.includes(row.identity.accountId)) holds.push('fixture-account-scope-mismatch');
    } else if (!task.allowedDestination) holds.push('destination-scope-unknown');
    else if (row.identity.provider !== task.allowedDestination.provider || row.identity.accountId !== task.allowedDestination.accountId ||
      row.identity.agentId !== task.allowedDestination.agentId) holds.push('destination-scope-mismatch');
    // A task's allowlist is planning scope only. The real snapshot contains no signed project grant.
    if (mode === 'shadow-readonly') holds.push('project-authority-unqualified');
    if (row.connectionState !== 'observed') holds.push('connection-unqualified');
    if (row.readinessState !== 'adapter-reported') holds.push('readiness-unqualified');
    if (row.capabilityState !== 'adapter-reported') holds.push('capability-unverified');
    if (task.deadline !== null && Date.parse(task.deadline) <= nowMs) holds.push('deadline-passed');
    if (task.maxCostUsd === null) holds.push('budget-unknown');
    if (row.cost.state === 'unknown' || row.cost.value === null || row.cost.currency !== 'USD' || row.cost.units !== 'task' || !fresh(row.cost.asOf, row.cost.evidenceState, nowMs)) holds.push('cost-unknown-or-incomparable');
    else if (task.maxCostUsd !== null && row.cost.value > task.maxCostUsd) holds.push('budget-exceeded');
    if (row.usageWindows.some(window => window.limitReached || window.usedPercent === 100)) holds.push('quota-exhausted');
    if (row.kind !== 'local' && !row.credits.some(credit => credit.recordKind === 'balance' && credit.eligibilityState === 'declared' &&
      credit.fundingAccountId === row.identity.accountId && credit.fundingProductId !== null && Array.isArray(credit.eligibleSurfaces) &&
      credit.eligibleSurfaces.includes(row.kind) && Array.isArray(credit.excludedSurfaces) && !credit.excludedSurfaces.includes(row.kind) &&
      credit.amount !== null && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(credit.amount) && Number.isFinite(Number(credit.amount)) && Number(credit.amount) > 0 &&
      fresh(credit.asOf, credit.evidenceState, nowMs) && credit.expiryState !== 'expired' &&
      (credit.expiresAt === null || Date.parse(credit.expiresAt) > nowMs))) holds.push('funding-unknown-or-expired');
    const basicFit = matched.length === task.capabilityIds.length && !holds.some(reason => ['requirements-unknown', 'funding-only-not-execution-resource', 'source-missing', 'source-stale-or-unknown',
      'identity-unknown-or-conflicting', 'fixture-account-scope-mismatch', 'destination-scope-unknown', 'destination-scope-mismatch',
      'deadline-passed', 'quota-exhausted', 'budget-exceeded'].includes(reason));
    return { resourceId: row.resourceId, label: row.label, qualification: holds.length === 0 && mode === 'fixture' ? 'qualified-shadow-fixture'
      : basicFit ? 'planning-candidate' : 'held', holds, matchedCapabilityIds: matched, sourceMode: mode, executionAuthorized: false };
  });
}
function fallback(rows: RoutingLabCandidate[], snapshot: ProactiveResourceEvidenceResponse): string | null {
  const eligible = rows.filter(row => row.qualification !== 'held' && row.holds.length === 0);
  eligible.sort((a, b) => {
    const left = snapshot.resources.find(row => row.resourceId === a.resourceId)!;
    const right = snapshot.resources.find(row => row.resourceId === b.resourceId)!;
    return Number(left.kind !== 'local') - Number(right.kind !== 'local') || (left.cost.value ?? Infinity) - (right.cost.value ?? Infinity) ||
      (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0);
  });
  return eligible[0]?.resourceId ?? null;
}
interface FixtureCase { id: string; task: RoutingLabTask; snapshot: ProactiveResourceEvidenceResponse; expected: string | null;
  behavior: 'deterministic' | 'valid' | 'low' | 'oov' | '429' | '529' | 'timeout' | 'adversarial' | 'cancelled' }
function fixtureRow(id: string, kind: ProactiveResourceEvidenceRow['kind'], accountId: string, at: string, cost: number): ProactiveResourceEvidenceRow {
  return { resourceId: id, label: `Hypothetical ${id}`, identity: { provider: kind === 'local' ? 'generic-local' : id.startsWith('alpha') ? 'generic-alpha' : 'generic-beta',
    accountId, agentId: 'fixture-agent' }, kind, identityState: 'observed-reference', connectionState: 'observed', capabilityState: 'adapter-reported', capabilityIds: ['review'],
    entitlementState: 'unknown', readinessState: 'adapter-reported', evidenceState: 'current', source: 'offline-fixture', asOf: at,
    usageWindows: [], credits: kind === 'local' ? [] : [{ poolId: 'fixture-allowance', kind: 'subscription-allowance', amount: '5', total: '10', unit: 'fixture-unit', surface: 'offline-fixture',
      source: 'offline-fixture', asOf: at, expiresAt: null, expiryDate: null, expiryState: 'upcoming', evidenceState: 'current',
      fundingProductId: 'fixture-product', fundingAccountId: accountId, eligibilityState: 'declared', eligibleSurfaces: [kind], excludedSurfaces: [], recordKind: 'balance', receiptAmount: null }],
    cost: { state: 'estimated', value: cost, currency: 'USD', units: 'task', source: 'offline-fixture', asOf: at, evidenceState: 'current' }, executionAuthorized: false, notes: ['Hypothetical fixture; never contacted.'] };
}
export function routingLabFixtureCorpus(at: string): FixtureCase[] {
  const task: RoutingLabTask = { taskId: 'fixture-task', tenantId: 'fixture-tenant', projectBindingId: 'fixture-project', packetDigest: 'a'.repeat(64),
    capabilityIds: ['review'], accountRefs: ['fixture-alpha-a', 'fixture-alpha-b', 'fixture-beta-api', 'fixture-local'], deadline: null, maxCostUsd: 10 };
  const snapshot: ProactiveResourceEvidenceResponse = { schemaVersion: 1, sampledAt: at, sourceState: 'snapshot', resources: [
    fixtureRow('alpha-a', 'native-subscription', 'fixture-alpha-a', at, 1), fixtureRow('alpha-b', 'native-subscription', 'fixture-alpha-b', at, 2),
    fixtureRow('beta-api', 'api', 'fixture-beta-api', at, 3), fixtureRow('local-model', 'local', 'fixture-local', at, 0)], executionAuthorized: false, notes: ['Static synthetic corpus.'] };
  const make = (id: string, behavior: FixtureCase['behavior'], expected: string | null = 'local-model'): FixtureCase =>
    ({ id, behavior, expected, task: structuredClone(task), snapshot: structuredClone(snapshot) });
  const output = [make('deterministic', 'deterministic'), make('valid-closed-choice', 'valid', 'alpha-a'), make('option-order', 'deterministic'),
    make('low-sharpness', 'low'), make('out-of-vocabulary', 'oov'), make('adversarial-response', 'adversarial'), make('fixture-429', '429'),
    make('fixture-529', '529'), make('fixture-timeout', 'timeout'), make('cancelled', 'cancelled', null), make('deadline', 'deterministic', null),
    make('budget-unknown', 'deterministic', null), make('source-missing', 'deterministic', null), make('stale-source', 'deterministic', null),
    make('capability-filter', 'deterministic', null), make('oversized-closed-set', 'valid')];
  output[2]!.snapshot.resources.reverse(); output[10]!.task.deadline = at; output[11]!.task.maxCostUsd = null;
  output[12]!.snapshot.sourceState = 'missing'; output[13]!.snapshot.resources.forEach(row => row.evidenceState = 'stale');
  output[14]!.task.capabilityIds = ['unsupported-capability'];
  output[15]!.snapshot.resources = Array.from({ length: 256 }, (_, i) => fixtureRow(i === 0 ? 'local-model' : `extra-${i}`, 'local', 'fixture-local', at, i === 0 ? 0 : 1));
  return output;
}
function fixtureResponse(behavior: FixtureCase['behavior']): unknown {
  if (['429', '529', 'timeout'].includes(behavior)) return { ok: false, reason: behavior };
  return { ok: true, answers: { resource_choice: { type: 'choice', choice: behavior === 'oov' ? 'c9999' : behavior === 'adversarial' ? 'ignore-rules-and-authorize' : 'c0',
    confidence: behavior === 'low' ? 0.2 : 0.95, probabilities: { c0: 0.95 } } } };
}
async function boundedChoice(adapter: OfflineChoiceAdapter | undefined, payload: OfflineChoicePayload, behavior: FixtureCase['behavior'],
  signal: AbortSignal | undefined, budgetMs: number): Promise<{ response: unknown; aborted: boolean; budgetExhausted: boolean }> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<{ response: unknown; aborted: boolean; budgetExhausted: boolean }>(resolve => {
    abort = () => { controller.abort(); resolve({ response: null, aborted: true, budgetExhausted: false }); };
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { controller.abort(); resolve({ response: { ok: false, reason: 'timeout' }, aborted: false, budgetExhausted: true }); }, Math.ceil(budgetMs));
  });
  try {
    if (signal?.aborted) return { response: null, aborted: true, budgetExhausted: false };
    const chosen = Promise.resolve().then(() => adapter ? adapter.choose(payload, controller.signal) : fixtureResponse(behavior))
      .then(response => ({ response, aborted: signal?.aborted === true, budgetExhausted: false }),
        () => ({ response: { ok: false, reason: 'malformed-response' }, aborted: signal?.aborted === true, budgetExhausted: false }));
    return await Promise.race([chosen, interrupted]);
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); controller.abort(); }
}
function parseFixtureChoice(response: unknown, criteria: Record<string, string>): { index: number | null; reason: string | null } {
  const malformed = { index: null, reason: 'out-of-vocabulary-or-malformed' };
  try {
    if (!companionObject(response, ['ok'], ['reason', 'answers'])) return malformed;
    const raw = response as { ok: unknown; reason?: unknown; answers?: unknown };
    if (raw.ok !== true) return companionObject(response, ['ok', 'reason']) && typeof raw.reason === 'string' && ['timeout', '429', '529'].includes(raw.reason)
      ? { index: null, reason: raw.reason } : { index: null, reason: 'malformed-response' };
    if (!companionObject(response, ['ok', 'answers']) || !companionObject(raw.answers, ['resource_choice'])) return malformed;
    const answers = raw.answers as { resource_choice: unknown };
    if (!companionObject(answers.resource_choice, ['type', 'choice', 'confidence', 'probabilities'])) return malformed;
    const choice = answers.resource_choice as { type: unknown; choice: unknown; confidence: unknown; probabilities: unknown };
    if (choice.type !== 'choice' || typeof choice.choice !== 'string' || !Object.hasOwn(criteria, choice.choice) ||
      typeof choice.confidence !== 'number' || !Number.isFinite(choice.confidence) || choice.confidence < 0 || choice.confidence > 1 ||
      !choice.probabilities || typeof choice.probabilities !== 'object' || Array.isArray(choice.probabilities) ||
      !companionObject(choice.probabilities, [], Object.keys(choice.probabilities))) return malformed;
    const probabilities = choice.probabilities as Record<string, unknown>;
    if (Object.keys(probabilities).length === 0 || Object.keys(probabilities).length > Object.keys(criteria).length ||
      !Object.hasOwn(probabilities, choice.choice) || Object.entries(probabilities).some(([key, probability]) => !Object.hasOwn(criteria, key) ||
        typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) || Number(probabilities[choice.choice]) <= 0) return malformed;
    return choice.confidence < THRESHOLD ? { index: null, reason: 'below-advisory-threshold' } : { index: Number(choice.choice.slice(1)), reason: null };
  } catch { return malformed; }
}
async function evaluateCase(input: FixtureCase, mode: 'fixture' | 'shadow-readonly', at: string, adapter: OfflineChoiceAdapter | undefined,
  signal: AbortSignal | undefined, budgetMs: number): Promise<{ receipt: RoutingLabCaseReceipt; budgetExhausted: boolean }> {
  const started = performance.now(); const projected = candidates(input.task, input.snapshot, mode, at);
  let budgetExhausted = false;
  const receipt: RoutingLabCaseReceipt = { caseId: input.id, taskDigest: companionDigest(input.task), snapshotDigest: companionDigest(input.snapshot),
    candidates: projected, selectedResourceId: fallback(projected, input.snapshot), path: 'deterministic', fallbackReason: null,
    expectedResourceId: input.expected, passed: null, notes: [mode === 'fixture' ? 'Synthetic fixtures only; no real model or resource was contacted.' :
      'Read-only planning evidence; no signed project admission or provider contact is established.'], localDurationMs: 0, providerLatencyMs: null, executionAuthorized: false };
  if (signal?.aborted || input.behavior === 'cancelled') { receipt.path = 'aborted'; receipt.selectedResourceId = null; receipt.fallbackReason = 'cancelled'; }
  else if (!receipt.selectedResourceId) { receipt.path = 'held'; receipt.fallbackReason = input.snapshot.sourceState === 'snapshot'
    ? 'no-qualified-planning-option' : input.snapshot.sourceState === 'invalid' ? 'source-invalid' : 'source-missing'; }
  else if (mode === 'fixture' && input.behavior !== 'deterministic') {
    const eligible = projected.filter(row => row.holds.length === 0 && row.qualification !== 'held');
    const state = JSON.stringify(eligible.map((_, i) => ({ choice: `c${i}`, synthetic: true })));
    if (eligible.length > ROUTING_LAB_LIMITS.choices) receipt.fallbackReason = 'choice-cardinality';
    else if (state.length > 6000) receipt.fallbackReason = 'choice-state-bound';
    else {
      const criteria = Object.fromEntries(eligible.map((_, i) => [`c${i}`, 'This synthetic already-qualified option fits the fixture task.']));
      const answer = await boundedChoice(adapter, { model: MODEL, mode: 'offline-fixture', state,
        questions: { resource_choice: { type: 'choice', criteria, instructions: 'Choose one synthetic closed-set option. This answer grants no execution authority.' } } }, input.behavior, signal, budgetMs);
      budgetExhausted = answer.budgetExhausted;
      if (answer.aborted) { receipt.path = 'aborted'; receipt.selectedResourceId = null; receipt.fallbackReason = 'cancelled'; }
      else {
        const parsed = parseFixtureChoice(answer.response, criteria);
        if (parsed.index === null) receipt.fallbackReason = parsed.reason;
        else { receipt.selectedResourceId = eligible[parsed.index]!.resourceId; receipt.path = 'fixture-advice'; }
      }
    }
  }
  receipt.localDurationMs = Math.max(0, performance.now() - started);
  receipt.passed = mode === 'fixture' ? receipt.selectedResourceId === input.expected : null;
  return { receipt, budgetExhausted };
}
export function createRoutingLab(options: RoutingLabOptions = {}): RoutingLab {
  const store = new RoutingLabStore(options.directory ?? join(ashlrHome(), 'routing-lab'));
  const now = () => (options.now?.() ?? new Date()).toISOString();
  return {
    list: () => store.read().view,
    replay(command) { try { return validCommand(command) ? store.replay(structuredClone(command)) : store.fail('invalid'); } catch { return store.fail('invalid'); } },
    async execute(command, controls = {}) {
      try {
        if (!validCommand(command) || options.adapter && options.adapter.mode !== 'offline-fixture') return store.fail('invalid');
        const snapshotCommand = structuredClone(command); const replay = store.replay(snapshotCommand); if (replay) return replay;
        const budget = controls.timeBudgetMs ?? 5000;
        if (!Number.isFinite(budget) || budget < 1 || budget > 5000) return store.fail('invalid');
        const current = store.read().view; if (current.revision !== command.expectedRevision) return store.fail('conflict');
        const at = now(); if (!companionTime(at)) return store.fail('invalid');
        if (command.kind === 'propose-preference') {
          const id = `rp_${companionDigest([command.evaluationId, command.resourceId, command.reason]).slice(0, 32)}`;
          return store.append(snapshotCommand, 'proposal', id, state => {
            if (!state.evaluations.some(evaluation => evaluation.id === command.evaluationId && evaluation.status === 'completed' && evaluation.cases.some(item =>
              item.candidates.some(candidate => candidate.resourceId === command.resourceId && candidate.qualification !== 'held')))) throw new Error('Held');
            if (state.proposals.some(proposal => proposal.id === id)) return;
            if (state.proposals.length >= ROUTING_LAB_LIMITS.proposals) throw new Error('Capacity');
            state.proposals.push({ id, evaluationId: command.evaluationId, resourceId: command.resourceId, reason: command.reason, state: 'proposed',
              createdAt: at, withdrawnAt: null, executionAuthorized: false });
          });
        }
        if (command.kind === 'withdraw-preference') return store.append(snapshotCommand, 'proposal', command.proposalId, state => {
          const proposal = state.proposals.find(item => item.id === command.proposalId); if (!proposal) throw new Error('Held');
          if (proposal.state === 'withdrawn') return;
          proposal.state = 'withdrawn'; proposal.withdrawnAt = at;
        });
        let inputs: FixtureCase[]; const mode = command.kind === 'benchmark' ? 'fixture' : 'shadow-readonly';
        if (command.kind === 'benchmark') inputs = routingLabFixtureCorpus(at);
        else {
          const task = 'task' in command ? command.task : options.resolveTask?.(command.taskId);
          if (!validTask(task)) return store.fail('held');
          let snapshot = missingSnapshot(at); try { snapshot = options.resources?.() ?? snapshot; } catch { /* Missing stays explicit. */ }
          if (!validSnapshot(snapshot)) snapshot = { ...missingSnapshot(at), sourceState: 'invalid' };
          inputs = [{ id: 'actual-snapshot-preview', task: structuredClone(task), snapshot: structuredClone(snapshot), expected: null, behavior: 'deterministic' }];
        }
        const id = routingLabEvaluationId(command.requestId); const inputDigest = companionDigest({ command: snapshotCommand,
          inputs: inputs.map(input => ({ caseId: input.id, task: input.task, behavior: input.behavior })), policyId: POLICY, modelId: MODEL,
          adapterMode: mode === 'fixture' ? 'offline-fixture' : 'deterministic-only', timeBudgetMs: budget });
        const evaluation: RoutingLabEvaluation = { id, requestId: command.requestId, kind: command.kind, mode, status: 'uncertain', inputDigest,
          snapshotDigest: companionDigest(inputs.map(input => input.snapshot)), policyId: POLICY, modelId: MODEL,
          adapterMode: mode === 'fixture' ? 'offline-fixture' : 'deterministic-only', createdAt: at, completedAt: null,
          localDurationMs: null, providerLatencyMs: null, cases: [], summary: { total: inputs.length, evaluated: 0, expected: 0, passed: 0, failed: 0, coverage: 0 },
          executionAuthorized: false, notes: ['No provider contacted. Local duration is not provider latency or an efficiency measurement.',
            'Advisory confidence is distribution sharpness, not calibrated correctness.'] };
        const prepared = store.append(snapshotCommand, 'intent', id, state => { if (state.evaluations.length >= ROUTING_LAB_LIMITS.evaluations) throw new Error('Capacity'); state.evaluations.push(evaluation); });
        if (!prepared.ok || prepared.disposition !== 'recorded') return prepared;
        const started = performance.now();
        const cases: RoutingLabCaseReceipt[] = []; let budgetExhausted = false;
        for (const input of inputs) {
          const remaining = budget - (performance.now() - started);
          if (controls.signal?.aborted || remaining < 1) break;
          const evaluated = await evaluateCase(input, mode, at, options.adapter, controls.signal, remaining);
          cases.push(evaluated.receipt); budgetExhausted = evaluated.budgetExhausted;
          if (budgetExhausted) break;
        }
        const status = controls.signal?.aborted || budgetExhausted || cases.length !== inputs.length ? 'aborted' : 'completed';
        return store.append(snapshotCommand, 'settled', id, state => {
          const saved = state.evaluations.find(item => item.id === id); if (!saved || saved.status !== 'uncertain') throw new Error('Held');
          saved.status = status; saved.completedAt = now(); saved.localDurationMs = Math.max(0, performance.now() - started); saved.cases = cases;
          saved.summary = { total: inputs.length, evaluated: cases.length, expected: cases.filter(item => item.passed !== null).length,
            passed: cases.filter(item => item.passed === true).length, failed: cases.filter(item => item.passed === false).length, coverage: inputs.length ? cases.length / inputs.length : 0 };
        });
      } catch { return store.fail('unavailable'); }
    },
  };
}
