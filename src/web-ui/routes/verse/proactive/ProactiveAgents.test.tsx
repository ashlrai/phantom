import { companionDigestToReference, decodeCompanionWire } from '../../../../core/proactive/coordination-wire.js';
import { createHash, webcrypto } from 'node:crypto';
import type { CompanionTask, CompanionCommand } from '../../../../core/proactive/coordination-types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ProactiveProfile, ProactiveProfileInput } from '../../../../core/proactive/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json, TEST_TOKEN, type RecordedCall } from '../context/context-fixtures.test-support.js';
import { ProactiveAgents } from './ProactiveAgents.js';

const NOW = '2026-10-09T08:00:00.000Z';
function profile(over: Partial<ProactiveProfile> = {}): ProactiveProfile {
  return { id: 'pa_aaaaaaaaaaaaaaaa', version: 1, identity: { provider: 'openai-dot', accountId: 'account-one', agentId: 'dot-one' },
    displayName: 'Build companion', responsibility: 'Watch deployments', avatar: { color: '#5a59ef', variant: 'classic' },
    capabilityIds: [], capabilityVerification: 'declared-unverified', preferences: { priority: 50, maxConcurrent: 1, projectBindingIds: [] },
    computer: { kind: 'unknown', label: '', providerComputerId: null }, services: [], fundingReference: null, enabled: false,
    connection: 'configured', lastRun: null, createdAt: NOW, updatedAt: NOW,
    operations: { dispatch: { state: 'unverified', verifiedAt: null, note: 'No qualified transport.' },
      status: { state: 'unsupported', verifiedAt: null, note: 'No status interface.' },
      cancel: { state: 'unsupported', verifiedAt: null, note: 'No cancel interface.' },
      result: { state: 'unsupported', verifiedAt: null, note: 'No result interface.' } }, ...over };
}
function server(initial: ProactiveProfile[] = [], override?: (call: RecordedCall) => Response | undefined) {
  let profiles = initial;
  const { calls } = installFetch(call => {
    const custom = override?.(call); if (custom) return custom;
    if (call.path === '/api/verse/proactive-agents/coordination' && call.method === 'GET') return json({ schemaVersion: 1, revision: 0, tasks: [], packetDestinations: [], sourceState: 'missing', planningOnly: true, transport: 'unavailable' });
    if (call.path === '/api/verse/proactive-agents' && call.method === 'GET') return json({ schemaVersion: 1, profiles });
    if (call.path === '/api/verse/proactive-agents' && call.method === 'POST') {
      const input = call.body as ProactiveProfileInput; const saved = profile({ ...input, preferences: { priority: 50, maxConcurrent: 1, projectBindingIds: [], ...input.preferences }, id: 'pa_created', version: 1 });
      profiles = [...profiles, saved]; return json({ profile: saved }, 201);
    }
    if (call.path.endsWith('/delete') && call.method === 'POST') { profiles = []; return json({ ok: true }); }
    if (call.path.startsWith('/api/verse/proactive-agents/') && call.method === 'POST') {
      const { expectedVersion: _expected, ...patch } = call.body as { expectedVersion: number } & Partial<ProactiveProfile>;
      const saved = { ...profiles[0]!, ...patch, version: profiles[0]!.version + 1 }; profiles = [saved]; return json({ profile: saved });
    }
    return json({ error: 'not found' }, 404);
  });
  return { calls, update: (next: ProactiveProfile[]) => { profiles = next; } };
}
beforeEach(() => { evictAll(); clearMutationToken(); setMutationToken(TEST_TOKEN); });
afterEach(() => { evictAll(); clearMutationToken(); vi.unstubAllGlobals(); });

async function edit() { fireEvent.click(await screen.findByRole('button', { name: 'Edit Build companion' })); return screen.getByRole('dialog', { name: 'Edit Build companion' }); }
describe('proactive agent profiles', () => {
  it('prepares a dedicated Grok reviewer with required blank identities and saves only explicitly', async () => {
    const { calls } = server(); render(<ProactiveAgents />); await screen.findByText('Bring your persistent agents together');
    fireEvent.click(screen.getByRole('button', { name: 'Add Grok reviewer profile' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a proactive agent' });
    expect(within(dialog).getByLabelText('Provider')).toHaveValue('grok-bot');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Phantom improvement reviewer');
    expect(within(dialog).getByLabelText('Account identity')).toHaveValue(''); expect(within(dialog).getByLabelText('Agent identity')).toHaveValue('');
    expect((within(dialog).getByLabelText('Responsibility') as HTMLTextAreaElement).value).toContain('Do not post, merge, deploy');
    expect(within(dialog).getByLabelText('Declared capabilities')).toHaveValue('research, code-review');
    expect(within(dialog).getByRole('button', { name: 'Save profile' })).toBeDisabled(); expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('Account identity'), { target: { value: 'operator-account' } });
    fireEvent.change(within(dialog).getByLabelText('Agent identity'), { target: { value: 'existing-reviewer' } });
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }));
    await screen.findByRole('heading', { name: 'Phantom improvement reviewer' });
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({ identity: { provider: 'grok-bot', accountId: 'operator-account', agentId: 'existing-reviewer' },
      displayName: 'Phantom improvement reviewer', capabilityIds: ['research', 'code-review'], enabled: false, services: [], fundingReference: null });
    expect(screen.getByText('No qualified run evidence')).toBeInTheDocument();
  });
  it('shows an empty setup state without asserting connection or spending', async () => {
    server(); render(<ProactiveAgents />);
    await screen.findByText('Bring your persistent agents together');
    expect(screen.getByText(/connections, execution and funding are verified separately/)).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });
  it('offers official provider setup while keeping profile metadata distinct from commissioned transport', async () => {
    const { calls } = server([profile(), profile({ id: 'pa_grok', identity: { provider: 'grok-bot', accountId: 'account-grok', agentId: 'bot-one' } }),
      profile({ id: 'pa_meta', identity: { provider: 'meta-muse', accountId: 'account-meta', agentId: 'muse-one' } })]);
    render(<ProactiveAgents />);
    expect(await screen.findByRole('link', { name: 'OpenAI plugin events setup ↗' })).toHaveAttribute('href', 'https://developers.openai.com/plugins/build/mcp-events');
    expect(screen.getByRole('link', { name: 'Grok Bot routine setup ↗' })).toHaveAttribute('href', 'https://cursor.com/help/grok-bot/routines');
    expect(screen.getByRole('link', { name: 'Meta Muse product guide ↗' })).toHaveAttribute('href', 'https://ai.meta.com/muse/');
    expect(screen.getByText(/Meta Model API funding does not connect your personal Muse/)).toBeInTheDocument();
    expect(screen.getByText('Bot allowance and reset unknown · verify the billing account and product.')).toBeVisible();
    expect(calls.every(call => call.method === 'GET' && call.path.startsWith('/api/verse/proactive-agents'))).toBe(true);
  });
  it('refuses unsupported response versions instead of advertising an invented connection', async () => {
    server([], call => call.method === 'GET' && call.path === '/api/verse/proactive-agents' ? json({ schemaVersion: 2, profiles: [profile()] }) : undefined);
    render(<ProactiveAgents />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent profiles are unavailable');
    expect(screen.queryByRole('heading', { name: 'Build companion' })).not.toBeInTheDocument();
  });
  it('keeps unavailable reads distinct from an empty account list', async () => {
    server([], call => call.method === 'GET' && call.path === '/api/verse/proactive-agents' ? json({ code: 'UNAVAILABLE', error: 'Private records unavailable.' }, 503) : undefined);
    render(<ProactiveAgents />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent profiles are unavailable');
    expect(screen.queryByText('Bring your persistent agents together')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add agent' })).toBeDisabled();
  });
  it('persists an actual profile with normalized stable identity and a saved planning preference, without claiming capabilities', async () => {
    const { calls } = server(); render(<ProactiveAgents />); await screen.findByText('Bring your persistent agents together');
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a proactive agent' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'My Dot' } });
    fireEvent.change(within(dialog).getByLabelText('Account identity'), { target: { value: '  account-two  ' } });
    fireEvent.change(within(dialog).getByLabelText('Agent identity'), { target: { value: ' dot-two ' } });
    fireEvent.change(within(dialog).getByLabelText('Responsibility'), { target: { value: 'Improve Phantom' } });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Save planning preference' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }));
    await screen.findByRole('heading', { name: 'My Dot' });
    const post = calls.find(call => call.method === 'POST')!;
    expect(post.headers['x-ashlr-token']).toBe(TEST_TOKEN);
    expect(post.body).toMatchObject({ identity: { provider: 'openai-dot', accountId: 'account-two', agentId: 'dot-two' }, responsibility: 'Improve Phantom', enabled: true, fundingReference: null });
    expect(screen.getByText('Planning preference on')).toBeInTheDocument();
    expect(screen.getByText('Configured profile; transport unverified')).toBeInTheDocument();
    expect(screen.getByText('No qualified run evidence')).toBeInTheDocument();
  });
  it('updates only editable fields with the exact saved CAS version and same-account funding reference', async () => {
    const { calls } = server([profile({ version: 7 })]); render(<ProactiveAgents />); const dialog = await edit();
    expect(within(dialog).getByLabelText('Provider')).toBeDisabled();
    expect(within(dialog).getByLabelText('Account identity')).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Release partner' } });
    fireEvent.change(within(dialog).getByLabelText('Funding kind'), { target: { value: 'promotional-api' } });
    fireEvent.change(within(dialog).getByLabelText('Pool identity'), { target: { value: 'pool-one' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }));
    await screen.findByRole('heading', { name: 'Release partner' });
    expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({ expectedVersion: 7, displayName: 'Release partner', fundingReference: { kind: 'promotional-api', accountId: 'account-one', poolId: 'pool-one' } });
    expect(calls.find(call => call.method === 'POST')?.body).not.toHaveProperty('identity');
  });
  it('preserves stale drafts, refuses repeated overwrite, and requires explicit latest reload', async () => {
    const api = server([profile()], call => call.method === 'POST' ? json({ code: 'CONFLICT', error: 'Profile changed.' }, 409) : undefined);
    render(<ProactiveAgents />); const dialog = await edit();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'My unsaved name' } });
    api.update([profile({ version: 2, displayName: 'Other window name' })]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }));
    await within(dialog).findByRole('alert');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('My unsaved name');
    expect(within(dialog).getByRole('button', { name: 'Save profile' })).toBeDisabled();
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Load latest profile' }));
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Other window name');
  });
  it('asks only for the existing mutation token and sends no profile without it', async () => {
    clearMutationToken(); const { calls } = server([profile()]); render(<ProactiveAgents />); const dialog = await edit();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('dialog', { name: /Unlock/i })).toBeInTheDocument();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });
  it('deletes only the saved profile revision and does not cancel its provider agent', async () => {
    const { calls } = server([profile({ version: 3 })]); render(<ProactiveAgents />); const dialog = await edit();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete profile' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete this profile?' });
    expect(confirm).toHaveTextContent('It does not stop or delete the provider’s agent');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete agent profile' }));
    await screen.findByText('Agent profile deleted.');
    expect(calls.filter(call => call.method === 'POST').map(call => ({ path: call.path, body: call.body }))).toEqual([{ path: '/api/verse/proactive-agents/pa_aaaaaaaaaaaaaaaa/delete', body: { expectedVersion: 3 } }]);
  });
});

const DIGEST = 'a'.repeat(64);
function task(over: Partial<CompanionTask> = {}): CompanionTask {
  return { id: 'ct_local', tenantId: 'tenant-one', projectBindingId: 'project-one', taskKey: 'review-one', goal: 'Review a local artifact',
    acceptance: ['Find and cite a concrete issue'], packetDigest: DIGEST, capabilityIds: ['review'], deadline: null, maxCostUsd: null, maxAttempts: 1,
    createdAt: NOW, updatedAt: NOW, state: 'draft', attempts: [], reports: [], verifications: [], events: [], notification: null, ...over };
}
const GENERIC_PROFILES = [profile({ identity: { provider: 'custom-lab', accountId: 'account-one', agentId: 'agent-one' }, displayName: 'Reviewer one', enabled: true, capabilityIds: ['review'] }),
  profile({ id: 'pa_second', identity: { provider: 'custom-lab', accountId: 'account-two', agentId: 'agent-two' }, displayName: 'Reviewer two', enabled: true, capabilityIds: ['review'] })];
function coordinationServer(initial: CompanionTask[] = [], intercept?: (call: RecordedCall) => Response | undefined) {
  let tasks = initial; let revision = 0;
  const api = server(GENERIC_PROFILES, call => {
    const custom = intercept?.(call); if (custom) return custom;
    if (call.path === '/api/verse/proactive-agents/coordination/packet') return json({ packetDigest: DIGEST, dispatchAuthorized: false });
    if (call.path !== '/api/verse/proactive-agents/coordination') return undefined;
    if (call.method === 'GET') return json({ schemaVersion: 1, revision, tasks, packetDestinations: tasks.map(item => ({ taskId: item.id, identity: GENERIC_PROFILES[1]!.identity })), sourceState: 'healthy', planningOnly: true, transport: 'unavailable' });
    const command = decodeCompanionWire(call.body) as CompanionCommand;
    let saved = command.kind === 'create' ? task({ ...command.task }) : tasks.find(item => item.id === ('taskId' in command ? command.taskId : ''))!;
    if (command.kind === 'assign') saved = { ...saved, state: 'assigned', attempts: [{ id: 'attempt-one', epoch: 1, assignee: command.assignee, ownerId: command.ownerId, claimedAt: NOW, leaseExpiresAt: '2026-10-09T08:30:00.000Z', packetDigest: saved.packetDigest, contact: 'not-contacted', handoffAt: null, cancelRequestedAt: null, providerRunId: null, observationReference: null }] };
    if (command.kind === 'handoff') saved = { ...saved, state: 'handoff-intent', attempts: saved.attempts.map(attempt => ({ ...attempt, contact: 'intent', handoffAt: NOW })) };
    if (command.kind === 'cancel') saved = { ...saved, state: 'cancel-requested', notification: { eventId: 'cancel-event', state: 'pending', reason: 'cancel-requested', at: NOW } };
    if (command.kind === 'report') saved = { ...saved, state: 'reported', reports: [{ id: 'report-one', attemptId: command.attemptId, epoch: command.epoch, packetDigest: command.packetDigest, producer: saved.attempts.at(-1)!.assignee, result: command.result, resultDigest: 'b'.repeat(64), report: command.report, reportDigest: 'c'.repeat(64), source: 'manual-unverified', sourceReference: command.sourceReference, submittedAt: NOW, stale: false }] };
    if (command.kind === 'operator-review') saved = { ...saved, state: command.acceptanceMet ? 'verified' : 'needs-attention', verifications: [{ id: 'review-one', reportId: command.reportId, checkedResultDigest: command.checkedResultDigest, reviewer: command.reviewer, acceptanceMet: command.acceptanceMet, applied: command.acceptanceMet, source: 'manual-operator-review', at: NOW }], notification: { eventId: 'review-event', state: 'pending', reason: command.acceptanceMet ? 'verified' : 'needs-attention', at: NOW } };
    if (command.kind === 'notification-ack') saved = { ...saved, notification: saved.notification ? { ...saved.notification, state: 'acknowledged' } : null };
    tasks = [...tasks.filter(item => item.id !== saved.id), saved]; revision++;
    return json({ ok: true, disposition: 'recorded', revision, taskId: saved.id, task: saved, dispatchAuthorized: false });
  });
  return { ...api, updateTasks: (next: CompanionTask[]) => { tasks = next; revision++; } };
}
async function assignTask() {
  fireEvent.click(await screen.findByText('Record an assignment'));
  fireEvent.change(screen.getByLabelText('Agent profile'), { target: { value: 'pa_second' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save local assignment' }));
  await screen.findByText('assigned');
}
describe('local companion coordination operator experience', () => {
  it('supports arbitrary provider IDs, multiple accounts and declared preferences without qualifying them', async () => {
    server(GENERIC_PROFILES); render(<ProactiveAgents />);
    await screen.findByRole('heading', { name: 'Reviewer two' });
    expect(screen.getAllByText('custom-lab')).toHaveLength(2);
    expect(screen.getAllByText('review · unverified')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a proactive agent' });
    fireEvent.change(within(dialog).getByLabelText('Provider'), { target: { value: 'another-provider' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Third agent' } });
    fireEvent.change(within(dialog).getByLabelText('Account identity'), { target: { value: 'third-account' } });
    fireEvent.change(within(dialog).getByLabelText('Agent identity'), { target: { value: 'third-agent' } });
    fireEvent.change(within(dialog).getByLabelText('Declared capabilities'), { target: { value: 'research, review, research' } });
    fireEvent.change(within(dialog).getByLabelText('Planning priority'), { target: { value: '80' } });
    fireEvent.change(within(dialog).getByLabelText('Preferred concurrency'), { target: { value: '2' } });
    fireEvent.change(within(dialog).getByLabelText('Preferred project bindings'), { target: { value: 'project-one' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }));
    await screen.findByRole('heading', { name: 'Third agent' });
    expect(screen.getByText('research, review · unverified')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });
  it('prepares a local metadata packet and records a goal without asking for an implementation digest', async () => {
    const { calls } = coordinationServer(); render(<ProactiveAgents />);
    await screen.findByText('No local tasks recorded.');
    fireEvent.click(screen.getByRole('button', { name: 'Record task' }));
    const dialog = screen.getByRole('dialog', { name: 'Record a local task' });
    for (const [label, value] of [['Tenant identity', 'tenant-one'], ['Project binding', 'project-one'], ['Task key', 'review-one'], ['Goal', 'Review a local artifact'], ['Acceptance criteria', 'Find and cite a concrete issue'], ['Required capability IDs', 'review'], ['Packet recipient', 'pa_second']]) {
      fireEvent.change(within(dialog).getByLabelText(label!), { target: { value } });
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save local task' }));
    await screen.findByRole('heading', { name: 'Review a local artifact' });
    const writes = calls.filter(call => call.method === 'POST');
    expect(writes.map(call => call.path)).toEqual(['/api/verse/proactive-agents/coordination/packet', '/api/verse/proactive-agents/coordination']);
    expect(writes[0]?.body).toMatchObject({ profileId: 'pa_second', tenantId: 'tenant-one', projectBindingId: 'project-one' });
    expect(writes[1]?.body).toMatchObject({ kind: 'create', expectedRevision: 0, task: { packetDigest: companionDigestToReference(DIGEST), capabilityIds: ['review'] } });
    expect(screen.getByText(/provider transport unavailable/)).toBeVisible();
  });
  it('records scoped ownership, handoff and cancellation without implying contact', async () => {
    const { calls } = coordinationServer([task()]); render(<ProactiveAgents />); await assignTask();
    expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({ kind: 'assign', assignee: GENERIC_PROFILES[1]!.identity, ownerId: 'local-operator', leaseMs: 1_800_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare handoff intent' }));
    await screen.findByText(/Handoff intent recorded locally/);
    fireEvent.click(screen.getByRole('button', { name: 'Record cancellation intent' }));
    await screen.findByText(/Provider cancellation is unconfirmed/);
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(3);
    expect(screen.queryByText('accepted')).not.toBeInTheDocument();
  });
  it('preserves report drafts and retries the identical command after an ambiguous response', async () => {
    let fail = true;
    const { calls } = coordinationServer([task()], call => call.method === 'POST' && (call.body as CompanionCommand).kind === 'assign' && fail ? (fail = false, json({ error: 'Unconfirmed local write' }, 503)) : undefined);
    render(<ProactiveAgents />); fireEvent.click(await screen.findByText('Record an assignment'));
    fireEvent.change(screen.getByLabelText('Agent profile'), { target: { value: 'pa_second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save local assignment' }));
    await screen.findByRole('button', { name: 'Retry exact local command' });
    expect(screen.getByLabelText('Agent profile')).toHaveValue('pa_second');
    expect(screen.getByRole('button', { name: 'Save local assignment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact local command' }));
    await screen.findByText('assigned');
    expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([calls.find(call => call.method === 'POST')!.body, calls.find(call => call.method === 'POST')!.body]);
  });
  it.each([400, 401, 403, 404, 413])('keeps a rejected report editable after HTTP %s and accepts a corrected new command', async status => {
    let reject = true;
    const { calls } = coordinationServer([task()], call => call.method === 'POST' && (call.body as CompanionCommand).kind === 'report' && reject
      ? (reject = false, json({ error: 'Report rejected before recording', code: 'REJECTED' }, status)) : undefined);
    render(<ProactiveAgents />); await assignTask();
    fireEvent.click(screen.getByText('Record a manual report'));
    fireEvent.change(screen.getByLabelText('Result text'), { target: { value: 'My original result' } });
    fireEvent.change(screen.getByLabelText('Report summary'), { target: { value: 'Preserve this summary' } });
    fireEvent.change(screen.getByLabelText('Source reference'), { target: { value: 'operator:local-artifact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save manual report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The local command was rejected. Your draft is preserved');
    expect(screen.getByLabelText('Result text')).toHaveValue('My original result');
    expect(screen.getByLabelText('Report summary')).toHaveValue('Preserve this summary');
    expect(screen.getByLabelText('Result text')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save manual report' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Retry exact local command' })).not.toBeInTheDocument();
    // A token rejection clears the existing hold; restore it for this fixture's
    // corrected submission rather than exercising the separate unlock dialog.
    setMutationToken(TEST_TOKEN);
    fireEvent.change(screen.getByLabelText('Result text'), { target: { value: 'My corrected result' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save manual report' }));
    await screen.findByText('reported');
    const reports = calls.filter(call => call.method === 'POST' && (call.body as CompanionCommand).kind === 'report');
    expect(reports).toHaveLength(2);
    expect(reports[0]!.body).toMatchObject({ result: 'My original result' });
    expect(reports[1]!.body).toMatchObject({ result: 'My corrected result', report: 'Preserve this summary' });
    expect((reports[1]!.body as CompanionCommand).commandId).not.toBe((reports[0]!.body as CompanionCommand).commandId);
  });
  it('records manual evidence, a failed operator review and one acknowledged notification', async () => {
    const { calls } = coordinationServer([task()]); render(<ProactiveAgents />); await assignTask();
    fireEvent.click(screen.getByText('Record a manual report'));
    fireEvent.change(screen.getByLabelText('Result text'), { target: { value: 'No cited issue found.' } });
    fireEvent.change(screen.getByLabelText('Report summary'), { target: { value: 'Insufficient evidence' } });
    fireEvent.change(screen.getByLabelText('Source reference'), { target: { value: 'operator:local-artifact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save manual report' }));
    await screen.findByText('reported');
    fireEvent.click(screen.getByText('Record operator verification'));
    fireEvent.change(screen.getByLabelText('Reviewer identity'), { target: { value: 'reviewer-one' } });
    fireEvent.click(screen.getByLabelText('I reviewed this exact result and its acceptance criteria'));
    fireEvent.click(screen.getByRole('button', { name: 'Save operator review' }));
    await screen.findByText('needs-attention');
    expect(calls.filter(call => call.method === 'POST').at(-1)?.body).toMatchObject({ kind: 'operator-review', checkedResultDigest: companionDigestToReference('b'.repeat(64)), acceptanceMet: false });
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge notification' }));
    await screen.findByText(/needs-attention · acknowledged/);
    expect(screen.queryByRole('button', { name: 'Acknowledge notification' })).not.toBeInTheDocument();
    expect(screen.queryByText(/independently verified outcome$/)).not.toBeInTheDocument();
  });
  it('disables ledger writes when records are degraded', async () => {
    coordinationServer([task()], call => call.path.endsWith('/coordination') && call.method === 'GET' ? json({ schemaVersion: 1, revision: 1, tasks: [task()], packetDestinations: [], sourceState: 'degraded', planningOnly: true, transport: 'unavailable' }) : undefined);
    render(<ProactiveAgents />);
    await screen.findByText(/coordination ledger is degraded/);
    expect(screen.getByRole('button', { name: 'Record task' })).toBeDisabled();
  });
});

describe('coordination conflicts and wire evidence', () => {
  it('loads Grok review controls only after an explicit click on a current recorded handoff intent', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const recipient = profile({ id: 'pa_' + 'c'.repeat(24), version: 2, enabled: true, capabilityIds: ['review'],
      identity: { provider: 'grok-bot', accountId: 'grok-account', agentId: 'release-bot' } });
    const local = task({ id: 'ct_' + 'a'.repeat(32), state: 'handoff-intent', attempts: [{ id: 'b'.repeat(64), epoch: 1,
      assignee: recipient.identity, ownerId: 'operator', claimedAt: NOW, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      packetDigest: DIGEST, contact: 'intent', handoffAt: NOW, cancelRequestedAt: null, providerRunId: null, observationReference: null }] });
    const briefText = 'Manual copy is not acceptance or completion.\n{"goal":"Review the exact local artifact"}';
    const { calls } = server([recipient], call => {
      if (call.path.endsWith('/coordination') && call.method === 'GET') return json({ schemaVersion: 1, revision: 4, tasks: [local],
        packetDestinations: [{ taskId: local.id, identity: recipient.identity }], sourceState: 'healthy', planningOnly: true, transport: 'unavailable' });
      if (call.path.endsWith('/handoff-preview')) return json({ schemaVersion: 1, taskId: local.id, attemptId: companionDigestToReference(local.attempts[0]!.id),
        epoch: 1, revision: 4, profileId: recipient.id, profileVersion: 2, packetDigest: companionDigestToReference(DIGEST),
        previewDigest: companionDigestToReference(createHash('sha256').update(briefText).digest('hex')), briefText,
        dispatchAuthorized: false, contextShared: false, transport: 'manual-copy' });
      return undefined;
    });
    render(<ProactiveAgents />);
    const open = await screen.findByRole('button', { name: 'Review Grok Bot brief' }); expect(open).toBeEnabled();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
    fireEvent.click(open); await screen.findByLabelText('Grok Bot brief');
    expect(calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/api/verse/proactive-agents/coordination/handoff-preview']);
    expect(screen.getByRole('button', { name: 'Recheck and copy brief' })).toBeDisabled();
    expect(screen.getByText('Record a manual report')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(screen.queryByRole('dialog', { name: 'Review Grok Bot brief' })).not.toBeInTheDocument();
  });
  it.each(['assigned', 'future-profile'])('does not offer actionable Grok copy for %s', async mode => {
    const recipient = profile({ id: 'pa_' + 'c'.repeat(24), enabled: true, capabilityIds: ['review'],
      updatedAt: mode === 'future-profile' ? new Date(Date.now() + 60_000).toISOString() : NOW,
      identity: { provider: 'grok-bot', accountId: 'grok-account', agentId: 'release-bot' } });
    const local = task({ state: mode === 'assigned' ? 'assigned' : 'handoff-intent', attempts: [{ id: 'b'.repeat(64), epoch: 1,
      assignee: recipient.identity, ownerId: 'operator', claimedAt: NOW, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      packetDigest: DIGEST, contact: mode === 'assigned' ? 'not-contacted' : 'intent', handoffAt: mode === 'assigned' ? null : NOW,
      cancelRequestedAt: null, providerRunId: null, observationReference: null }] });
    const { calls } = server([recipient], call => call.path.endsWith('/coordination') && call.method === 'GET' ? json({ schemaVersion: 1, revision: 4,
      tasks: [local], packetDestinations: [{ taskId: local.id, identity: recipient.identity }], sourceState: 'healthy', planningOnly: true, transport: 'unavailable' }) : undefined);
    render(<ProactiveAgents />); await screen.findByRole('heading', { name: local.goal });
    if (mode === 'assigned') expect(screen.queryByRole('button', { name: 'Review Grok Bot brief' })).not.toBeInTheDocument();
    else expect(screen.getByRole('button', { name: 'Review Grok Bot brief' })).toBeDisabled();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });
  it('preserves a goal draft after a revision conflict and requires an explicit latest-revision acknowledgement', async () => {
    let conflict = true;
    const api = coordinationServer([], call => call.method === 'POST' && (call.body as CompanionCommand).kind === 'create' && conflict ? json({ error: 'Ledger changed' }, 409) : undefined);
    render(<ProactiveAgents />); await screen.findByText('No local tasks recorded.');
    fireEvent.click(screen.getByRole('button', { name: 'Record task' }));
    const dialog = screen.getByRole('dialog', { name: 'Record a local task' });
    for (const [label, value] of [['Tenant identity', 'tenant-one'], ['Project binding', 'project-one'], ['Task key', 'review-one'], ['Goal', 'Preserve my draft'], ['Acceptance criteria', 'Cite a source'], ['Packet recipient', 'pa_second']]) {
      fireEvent.change(within(dialog).getByLabelText(label!), { target: { value } });
    }
    api.updateTasks([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save local task' }));
    await within(dialog).findByRole('button', { name: 'Use latest ledger revision' });
    expect(within(dialog).getByLabelText('Goal')).toHaveValue('Preserve my draft');
    expect(within(dialog).getByRole('button', { name: 'Save local task' })).toBeDisabled();
    conflict = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use latest ledger revision' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save local task' }));
    await screen.findByRole('heading', { name: 'Preserve my draft' });
    const commands = api.calls.filter(call => call.method === 'POST' && (call.body as CompanionCommand).kind === 'create');
    expect(commands.map(call => (call.body as CompanionCommand).expectedRevision)).toEqual([0, 1]);
  });
  it('decodes typed packet digest references without treating them as missing or incompatible records', async () => {
    coordinationServer([], call => call.path.endsWith('/coordination') && call.method === 'GET' ? json({ schemaVersion: 1, revision: 1, tasks: [task({ packetDigest: companionDigestToReference(DIGEST) })], packetDestinations: [{ taskId: 'ct_local', identity: GENERIC_PROFILES[1]!.identity }], sourceState: 'healthy', planningOnly: true, transport: 'unavailable' }) : undefined);
    render(<ProactiveAgents />);
    await screen.findByRole('heading', { name: 'Review a local artifact' });
    fireEvent.click(screen.getByText('Scope and recorded evidence'));
    expect(screen.getByText(DIGEST)).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
