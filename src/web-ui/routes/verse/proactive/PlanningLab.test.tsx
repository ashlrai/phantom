import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { RoutingLabEvaluation, RoutingLabView, RoutingLabWrite } from '../../../../core/proactive/routing-lab-types.js';
import type { ProactiveResourceEvidenceResponse, ProactiveResourceEvidenceRow } from '../../../../core/proactive/resource-evidence-types.js';
import type { CompanionTask } from '../../../../core/proactive/coordination-types.js';
import { decodeCompanionWire, projectCompanionWire } from '../../../../core/proactive/coordination-wire.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json, TEST_TOKEN, type RecordedCall } from '../context/context-fixtures.test-support.js';
import type { PlanningCommand, ReleaseReadinessResponse } from './planning-queries.js';
import { PlanningLab } from './PlanningLab.js';

const NOW = '2026-10-12T08:00:00.000Z';
const HASH = 'a'.repeat(64);
const PATH = '/api/verse/proactive-agents/planning';
function resource(over: Partial<ProactiveResourceEvidenceRow> = {}): ProactiveResourceEvidenceRow {
  return { resourceId: 'resource-one', label: 'Generic reviewer one', identity: { provider: 'generic-lab', accountId: 'account-one', agentId: 'agent-one' },
    kind: 'personal-agent', identityState: 'declared', connectionState: 'configured', capabilityState: 'declared-unverified', capabilityIds: ['review'],
    entitlementState: 'unknown', readinessState: 'unverified', evidenceState: 'missing', source: 'saved-profile', asOf: NOW,
    usageWindows: [], credits: [], cost: { state: 'unknown', value: null, currency: null, units: null, source: null, asOf: null, evidenceState: 'missing' },
    executionAuthorized: false, notes: [], ...over };
}
function resources(): ProactiveResourceEvidenceResponse {
  return { schemaVersion: 1, sampledAt: NOW, sourceState: 'snapshot', executionAuthorized: false, notes: ['Saved declarations only; no collector was run.'],
    resources: [resource(), resource({ resourceId: 'resource-two', label: 'Generic reviewer two', identity: { provider: 'generic-lab', accountId: 'account-two', agentId: 'agent-two' }, evidenceState: 'stale',
      usageWindows: [{ id: 'daily', usedPercent: 0, resetsAt: null, resetDescription: null, limitReached: false, observedAt: NOW, evidenceState: 'stale' }],
      credits: [{ poolId: 'pool-two', kind: 'gifted-cloud', amount: '250', total: null, unit: 'native-credits', surface: 'fixture-platform', source: 'cached-credit-record', asOf: NOW, expiresAt: '2026-10-01T00:00:00.000Z', expiryDate: null, expiryState: 'expired', evidenceState: 'stale', fundingProductId: null, fundingAccountId: null, eligibilityState: 'unknown', eligibleSurfaces: [], excludedSurfaces: [], recordKind: 'balance', receiptAmount: null }],
      cost: { state: 'estimated', value: 1.25, currency: 'USD', units: 'per task', source: 'operator-estimate', asOf: NOW, evidenceState: 'stale' } }),
      resource({ resourceId: 'funding-one', label: 'Recorded funding pool', kind: 'funding-pool', identity: { provider: 'generic-cloud', accountId: null, agentId: null }, connectionState: 'unknown', capabilityState: 'unknown', capabilityIds: [],
        credits: [{ poolId: 'purchase-one', kind: 'native-credit', amount: null, total: null, unit: 'native-credits', surface: 'cloud-session', source: 'declared-receipt', asOf: NOW, expiresAt: null, expiryDate: null, expiryState: 'unknown', evidenceState: 'missing', fundingProductId: 'generic-cloud-session', fundingAccountId: 'funding-account', eligibilityState: 'declared', eligibleSurfaces: ['cloud-session'], excludedSurfaces: ['api'], recordKind: 'purchase', receiptAmount: '12000' }] })] };
}
function task(): CompanionTask {
  return { id: 'ct_local', tenantId: 'tenant-one', projectBindingId: 'project-one', taskKey: 'review-one', goal: 'Review local artifact', acceptance: ['Cite an issue'], packetDigest: HASH, capabilityIds: ['review'],
    deadline: null, maxCostUsd: null, maxAttempts: 1, createdAt: NOW, updatedAt: NOW, state: 'draft', attempts: [], reports: [], verifications: [], events: [], notification: null };
}
function evaluation(over: Partial<RoutingLabEvaluation> = {}): RoutingLabEvaluation {
  const candidate = { resourceId: 'resource-one', label: 'Synthetic reviewer', qualification: 'qualified-shadow-fixture' as const, holds: [], matchedCapabilityIds: ['review'], sourceMode: 'fixture' as const, executionAuthorized: false as const };
  return { id: 'evaluation-one', requestId: 'request-one', kind: 'benchmark', mode: 'fixture', status: 'completed', inputDigest: HASH, snapshotDigest: HASH,
    policyId: 'companion-routing-lab-v1', modelId: 'jev-1.13.0', adapterMode: 'offline-fixture', createdAt: NOW, completedAt: NOW, localDurationMs: 3, providerLatencyMs: null, executionAuthorized: false, notes: ['Synthetic corpus only.'],
    cases: [{ caseId: 'expected-selection', taskDigest: HASH, snapshotDigest: HASH, candidates: [candidate], selectedResourceId: 'resource-one', path: 'fixture-advice', fallbackReason: null, expectedResourceId: 'resource-one', passed: true, notes: [], localDurationMs: 1, providerLatencyMs: null, executionAuthorized: false },
      { caseId: 'wrong-expectation', taskDigest: HASH, snapshotDigest: HASH, candidates: [candidate], selectedResourceId: 'resource-one', path: 'deterministic', fallbackReason: 'malformed-response', expectedResourceId: 'resource-two', passed: false, notes: [], localDurationMs: 1, providerLatencyMs: null, executionAuthorized: false },
      { caseId: 'canceled-fixture', taskDigest: HASH, snapshotDigest: HASH, candidates: [{ ...candidate, qualification: 'held', holds: ['Entitlement unknown'] }], selectedResourceId: null, path: 'aborted', fallbackReason: 'offline-fixture canceled', expectedResourceId: null, passed: null, notes: ['No live provider work ran.'], localDurationMs: 1, providerLatencyMs: null, executionAuthorized: false }],
    summary: { total: 3, evaluated: 3, expected: 2, passed: 1, failed: 1, coverage: 1 }, ...over };
}
function release(): ReleaseReadinessResponse {
  return { schemaVersion: 1, sourceState: 'missing', readiness: null, notes: ['No exact commissioned release target has been supplied.'], releaseAuthorized: false };
}
function server(intercept?: (call: RecordedCall) => Response | undefined, initial?: Partial<RoutingLabView>) {
  let state: RoutingLabView = { schemaVersion: 1, revision: 0, sourceState: 'missing', evaluations: [], proposals: [], executionAuthorized: false, ...initial };
  const requests = new Map<string, RoutingLabWrite>();
  const { calls } = installFetch(call => {
    const custom = intercept?.(call); if (custom) return custom;
    if (call.path === `${PATH}/resources`) return json(resources());
    if (call.path === `${PATH}/release`) return json(release());
    if (call.path === '/api/verse/proactive-agents/coordination') return json(projectCompanionWire({ schemaVersion: 1, revision: 0, sourceState: 'healthy', tasks: [task()], packetDestinations: [], planningOnly: true, transport: 'unavailable' }));
    if (call.path !== PATH) return json({ error: 'not found' }, 404);
    if (call.method === 'GET') return json(projectCompanionWire(state));
    const command = decodeCompanionWire(call.body) as PlanningCommand;
    const replay = requests.get(command.requestId);
    if (replay?.ok) return json(projectCompanionWire({ ...replay, disposition: 'replayed' }));
    state = { ...state, sourceState: 'healthy', revision: state.revision + 1 };
    let saved: RoutingLabWrite;
    if (command.kind === 'benchmark' || command.kind === 'preview') {
      const result = evaluation({ id: `evaluation-${state.revision}`, requestId: command.requestId,
        ...(command.kind === 'preview' ? { kind: 'preview', mode: 'shadow-readonly', adapterMode: 'deterministic-only' } : {}) });
      state.evaluations = [...state.evaluations, result]; saved = { ok: true, disposition: 'recorded', revision: state.revision, evaluation: result, proposal: null, executionAuthorized: false };
    } else if (command.kind === 'propose-preference') {
      const proposal = { id: 'proposal-one', evaluationId: command.evaluationId, resourceId: command.resourceId, reason: command.reason, state: 'proposed' as const, createdAt: NOW, withdrawnAt: null, executionAuthorized: false as const };
      state.proposals = [...state.proposals, proposal]; saved = { ok: true, disposition: 'recorded', revision: state.revision, evaluation: null, proposal, executionAuthorized: false };
    } else {
      const proposal = { ...state.proposals.find(item => item.id === command.proposalId)!, state: 'withdrawn' as const, withdrawnAt: NOW };
      state.proposals = state.proposals.map(item => item.id === proposal.id ? proposal : item); saved = { ok: true, disposition: 'recorded', revision: state.revision, evaluation: null, proposal, executionAuthorized: false };
    }
    requests.set(command.requestId, saved); return json(projectCompanionWire(saved));
  });
  return { calls, update: (patch: Partial<RoutingLabView>) => { state = { ...state, ...patch }; } };
}
beforeEach(() => { evictAll(); clearMutationToken(); setMutationToken(TEST_TOKEN); });
afterEach(() => { evictAll(); clearMutationToken(); vi.unstubAllGlobals(); });
async function open() { fireEvent.click(screen.getByRole('button', { name: 'Open planning lab' })); await screen.findByRole('button', { name: 'Run offline demo' }); await screen.findByText('No offline evaluation receipts recorded.'); }

describe('planning lab', () => {
  it('defers reads until opened and separates account, connection, capabilities, entitlement and funding evidence', async () => {
    const { calls } = server(); render(<PlanningLab />); expect(calls).toHaveLength(0); await open();
    await screen.findByRole('heading', { name: 'Generic reviewer two' });
    expect(screen.getByText('generic-lab / account-one / agent-one')).toBeVisible();
    expect(screen.getByText('generic-lab / account-two / agent-two')).toBeVisible();
    expect(screen.getAllByText('configured')).toHaveLength(2);
    expect(screen.getAllByText('declared-unverified · review')).toHaveLength(2);
    expect(screen.getByText(/estimated · 1.25 USD per task/)).toBeVisible();
    expect(screen.getByText('Funding evidence · not execution capacity · funding-one')).toBeVisible();
    fireEvent.click(screen.getByText('Usage and funding evidence for Generic reviewer two'));
    expect(screen.getByText(/0% used · stale/)).toBeVisible();
    expect(screen.getByText(/gifted-cloud · Balance 250 native-credits/)).toBeVisible();
    expect(screen.getByText(/Expiry expired/)).toBeVisible();
    fireEvent.click(screen.getByText('Usage and funding evidence for Recorded funding pool'));
    expect(screen.getByText(/purchase receipt 12000 native-credits/)).toBeVisible();
    expect(screen.getByText(/excluded surfaces: api/)).toBeVisible();
    expect(screen.queryByText(/Balance 12000/)).not.toBeInTheDocument();
    expect(screen.getByText(/No exact commissioned release target/)).toBeVisible();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(screen.queryByRole('button', { name: /deploy|publish|install/i })).not.toBeInTheDocument();
  });
  it('records a visibly simulated demo with pass, fail, unknown and cancellation/fallback evidence', async () => {
    const { calls } = server(); render(<PlanningLab />); await open();
    fireEvent.click(screen.getByRole('button', { name: 'Run offline demo' }));
    await screen.findByRole('heading', { name: 'Simulated offline demo · completed' });
    expect(screen.getByText(/1 pass · 1 fail · 3\/3 evaluated/)).toBeVisible();
    fireEvent.click(screen.getByText('Candidate and fallback evidence for evaluation-1'));
    expect(screen.getByRole('heading', { name: 'canceled-fixture · expectation unknown' })).toBeVisible();
    expect(screen.getByText('Fallback: malformed-response')).toBeVisible();
    expect(screen.getByText('Fallback: offline-fixture canceled')).toBeVisible();
    const heldCase = screen.getByRole('heading', { name: 'canceled-fixture · expectation unknown' }).parentElement!;
    expect(within(heldCase).getByText('Held candidates cannot support a preference proposal.')).toBeVisible();
    expect(within(heldCase).queryByRole('button', { name: /Suggest preference review/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Provider latency and live performance are unknown/)).toBeVisible();
    const writes = calls.filter(call => call.method === 'POST');
    expect(writes).toHaveLength(1); expect(writes[0]?.body).toMatchObject({ kind: 'benchmark', expectedRevision: 0 });
    expect(writes[0]?.headers['x-ashlr-token']).toBe(TEST_TOKEN);
  });
  it('derives preview scope from a saved task ID instead of accepting browser account or packet edits', async () => {
    const { calls } = server(); render(<PlanningLab />); await open();
    fireEvent.change(screen.getByLabelText('Saved task'), { target: { value: 'ct_local' } });
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate cached task' }));
    await screen.findByRole('heading', { name: 'Cached-evidence shadow evaluation · completed' });
    expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({ kind: 'preview', taskId: 'ct_local', expectedRevision: 0 });
    expect(calls.find(call => call.method === 'POST')?.body).not.toHaveProperty('task');
    expect(calls.find(call => call.method === 'POST')?.body).not.toHaveProperty('accountRefs');
  });
  it('preserves exact request retry after an ambiguous error and prevents duplicate submissions', async () => {
    let fail = true;
    const { calls } = server(call => call.path === PATH && call.method === 'POST' && fail ? (fail = false, json({ error: 'Response uncertain' }, 500)) : undefined);
    render(<PlanningLab />); await open();
    const run = screen.getByRole('button', { name: 'Run offline demo' }); fireEvent.click(run); fireEvent.click(run);
    await screen.findByRole('button', { name: 'Retry exact offline request' });
    expect(run).toBeDisabled(); expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact offline request' }));
    await screen.findByRole('heading', { name: 'Simulated offline demo · completed' });
    const writes = calls.filter(call => call.method === 'POST'); expect(writes).toHaveLength(2); expect(writes[0]?.body).toEqual(writes[1]?.body);
  });
  it.each([400, 401, 403, 404, 413])('clears definitive HTTP %s rejection without losing the task selection', async status => {
    let fail = true;
    const { calls } = server(call => call.path === PATH && call.method === 'POST' && fail ? (fail = false, json({ error: 'Rejected before record', code: 'REJECTED' }, status)) : undefined);
    render(<PlanningLab />); await open(); fireEvent.change(screen.getByLabelText('Saved task'), { target: { value: 'ct_local' } });
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate cached task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The offline request was rejected');
    expect(screen.getByLabelText('Saved task')).toHaveValue('ct_local');
    expect(screen.queryByRole('button', { name: 'Retry exact offline request' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Evaluate cached task' })).toBeEnabled();
    setMutationToken(TEST_TOKEN); fireEvent.click(screen.getByRole('button', { name: 'Evaluate cached task' }));
    await screen.findByRole('heading', { name: 'Cached-evidence shadow evaluation · completed' });
    const writes = calls.filter(call => call.method === 'POST');
    expect((writes[0]?.body as PlanningCommand).requestId).not.toBe((writes[1]?.body as PlanningCommand).requestId);
  });
  it('preserves selection on revision conflict and requires an explicit latest revision review', async () => {
    let conflict = true;
    const api = server(call => call.path === PATH && call.method === 'POST' && conflict ? json({ error: 'Conflict' }, 409) : undefined);
    render(<PlanningLab />); await open(); fireEvent.change(screen.getByLabelText('Saved task'), { target: { value: 'ct_local' } });
    api.update({ revision: 1 }); fireEvent.click(screen.getByRole('button', { name: 'Evaluate cached task' }));
    await screen.findByRole('button', { name: 'Use latest planning revision' });
    expect(screen.getByLabelText('Saved task')).toHaveValue('ct_local');
    expect(screen.getByRole('button', { name: 'Evaluate cached task' })).toBeDisabled();
    conflict = false; fireEvent.click(screen.getByRole('button', { name: 'Use latest planning revision' }));
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate cached task' }));
    await screen.findByRole('heading', { name: 'Cached-evidence shadow evaluation · completed' });
    expect((api.calls.filter(call => call.method === 'POST').at(-1)?.body as PlanningCommand).expectedRevision).toBe(1);
  });
  it('stores and withdraws preference review proposals without applying policy', async () => {
    const { calls } = server(); render(<PlanningLab />); await open(); fireEvent.click(screen.getByRole('button', { name: 'Run offline demo' }));
    await screen.findByRole('heading', { name: 'Simulated offline demo · completed' }); fireEvent.click(screen.getByText('Candidate and fallback evidence for evaluation-1'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Suggest preference review for Synthetic reviewer' })[0]!);
    fireEvent.change(screen.getByLabelText('Preference review reason'), { target: { value: 'Review priority based on this offline expectation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save review proposal' }));
    await screen.findByRole('heading', { name: 'Proposal only · proposed' });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw review proposal' }));
    await screen.findByRole('heading', { name: 'Proposal only · withdrawn' });
    expect(screen.queryByRole('button', { name: /apply|enable/i })).not.toBeInTheDocument();
    expect(calls.filter(call => call.method === 'POST').map(call => (call.body as PlanningCommand).kind)).toEqual(['benchmark', 'propose-preference', 'withdraw-preference']);
  });
  it('keeps degraded, uncertain and aborted evidence distinct from a completed live result', async () => {
    server(undefined, { sourceState: 'degraded', evaluations: [evaluation({ id: 'uncertain-one', status: 'uncertain', completedAt: null, localDurationMs: null }), evaluation({ id: 'aborted-one', status: 'aborted' })] });
    render(<PlanningLab />); fireEvent.click(screen.getByRole('button', { name: 'Open planning lab' }));
    await screen.findByRole('heading', { name: 'Simulated offline demo · uncertain' });
    expect(screen.getByRole('heading', { name: 'Simulated offline demo · aborted' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run offline demo' })).toBeDisabled();
    expect(screen.getByText(/offline ledger is degraded/)).toBeVisible();
    expect(screen.getAllByText(/no confirmed complete result/)).toHaveLength(2);
  });
  it('rejects a planning projection claiming execution authority instead of advertising an executable provider', async () => {
    server(call => call.path === PATH && call.method === 'GET' ? json({ schemaVersion: 1, revision: 0, sourceState: 'healthy', evaluations: [], proposals: [], executionAuthorized: true }) : undefined);
    render(<PlanningLab />); fireEvent.click(screen.getByRole('button', { name: 'Open planning lab' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Planning records are unavailable');
    expect(screen.getByRole('button', { name: 'Run offline demo' })).toBeDisabled();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });
  it('shows exact release binding and simulated gates without offering a release action', async () => {
    server(call => call.path.endsWith('/release') ? json({ ...release(), sourceState: 'snapshot', readiness: { schemaVersion: 1,
      binding: { channel: 'website', targetId: 'fixture:website', version: 'fixture-v1', sourceRevision: 'fixture-revision', artifactDigest: HASH, attemptId: 'fixture-attempt' },
      asOf: NOW, readiness: 'blocked', simulated: true, evidenceLayer: 'simulated', gates: [{ id: 'tests', state: 'simulated', reason: 'Synthetic test receipt', receiptIds: ['fixture-receipt'] }, { id: 'recovery', state: 'unknown', reason: 'Recovery not commissioned', receiptIds: [] }], gaps: ['Live qualification missing'], releaseAuthorized: false,
      effects: { publish: false, deploy: false, install: false, serviceMutation: false, permissionChange: false } } }) : undefined);
    render(<PlanningLab />); await open();
    const releaseSection = screen.getByRole('region', { name: 'Release readiness' });
    expect(within(releaseSection).getByRole('heading', { name: 'Simulated release evidence · blocked' })).toBeVisible();
    expect(within(releaseSection).getByText('website / fixture:website')).toBeVisible();
    expect(within(releaseSection).getByText(HASH)).toBeVisible();
    expect(within(releaseSection).getByText('recovery · unknown')).toBeVisible();
    expect(within(releaseSection).queryByRole('button')).not.toBeInTheDocument();
  });
});
