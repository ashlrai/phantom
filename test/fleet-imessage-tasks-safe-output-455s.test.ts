import { describe, expect, it, vi } from 'vitest';
import { cmdFleetImessageTasks, type FleetImessageTasksDeps } from '../src/cli/fleet-imessage-tasks.js';
import { defaultConfig } from '../src/core/config.js';

// Entirely synthetic; deliberately ordinary strings defeat pattern-based scrubbing.
const privateFields = {
  token: 'FAKE_PRIVATE_CORRELATION_455', scope: 'FAKE_PRIVATE_SCOPE_455',
  format: 'FAKE_PRIVATE_FORMAT_455', summary: 'FAKE_PRIVATE_SUMMARY_455',
  handle: 'FAKE_PRIVATE_HANDLE_455', unexpected: { detail: 'FAKE_PRIVATE_UNKNOWN_455' },
};
const receipt = { rowid: 45501, sent: true, delivered: false, error: 0 };
const result = { rowid: 45502, status: 'DONE' as const, at: 1800000000300, evidence: 'peer-reported' };
function task() {
  return {
    ...privateFields, jobId: 'FAKE-455', peer: 'dot' as const, resource: 'imsg:dot', state: 'replied' as const,
    claimKey: 'queue:imsg.dot.FAKE-455', kind: 'research' as const, repo: 'fixture/example', prRefs: [455],
    createdAt: 1800000000100, attemptedAt: 1800000000200, deadline: '2099-01-01T00:00:00Z',
    receipt: { ...receipt, ...privateFields }, result: { ...result, ...privateFields },
    metrics: ['launch' as const], settled: true,
  };
}
const enqueue = ['enqueue', '--peer', 'dot', '--job', 'FAKE-455', '--kind', 'research',
  '--scope', 'Synthetic scope', '--repo', 'fixture/example', '--format', 'Synthetic format',
  '--deadline', '2099-01-01T00:00:00Z'];
async function invoke(args: string[], deps: FleetImessageTasksDeps) {
  const output = vi.fn();
  const code = await cmdFleetImessageTasks(args, { config: defaultConfig, ...deps, output });
  expect(output).toHaveBeenCalledTimes(1);
  const raw = output.mock.calls[0][0] as string;
  return { code, raw, report: JSON.parse(raw) };
}
function assertSafe(raw: string, report: Record<string, unknown>) {
  for (const value of ['FAKE_PRIVATE_', 'token', 'scope', 'format', 'summary', 'handle', 'unexpected', 'metrics', 'settled'])
    expect(raw).not.toContain(value);
  const row = (report.task ?? (report.tasks as unknown[])[0]) as Record<string, unknown>;
  expect(row).toEqual({
    jobId: 'FAKE-455', peer: 'dot' as const, resource: 'imsg:dot', state: 'replied' as const,
    claimKey: 'queue:imsg.dot.FAKE-455', kind: 'research' as const, repo: 'fixture/example', prRefs: [455],
    createdAt: 1800000000100, attemptedAt: 1800000000200, deadline: '2099-01-01T00:00:00Z',
    receipt, result,
  });
  expect(report.coverage).toBe('local-evidence-only-peer-reported-results-unverified');
  expect(report.claimKeyEvidence).toBe('label-only-queue-binding-unverified');
  expect(report).not.toHaveProperty('queueBinding');
}

describe('actual imessage-tasks CLI safe receipts', () => {
  it.each([false, true])('projects list output, json=%s', async json => {
    const list = vi.fn(() => ({ schema: 'fixture', state: 'healthy', tasks: [task()], ...privateFields }));
    const out = await invoke(['list', ...(json ? ['--json'] : [])], { list });
    expect(out.code).toBe(0);
    expect(list).toHaveBeenCalledWith();
    assertSafe(out.raw, out.report);
  });

  it.each([
    { args: enqueue, operation: 'enqueue', apply: false },
    { args: [...enqueue, '--dry-run'], operation: 'enqueue', apply: false },
    { args: [...enqueue, '--apply'], operation: 'enqueue', apply: true },
    { args: ['cancel', '--job', 'FAKE-455'], operation: 'cancel', apply: false },
    { args: ['cancel', '--job', 'FAKE-455', '--dry-run'], operation: 'cancel', apply: false },
    { args: ['cancel', '--job', 'FAKE-455', '--apply'], operation: 'cancel', apply: true },
  ] as const)('projects $operation apply=$apply: $args', async ({ args, operation, apply }) => {
    const response = { schema: 'fixture', state: apply ? 'queued' : 'planned',
      dryRun: !apply, approved: false, task: task(), ...privateFields };
    const operationFn = vi.fn(async () => response);
    const out = await invoke([...args, '--json'], { [operation]: operationFn });
    expect(out.code).toBe(0);
    expect(out.report).toMatchObject({ state: response.state, approved: false, dryRun: !apply });
    expect(operationFn.mock.calls).toHaveLength(1);
    expect(operationFn).toHaveBeenCalledWith(...(operation === 'enqueue'
      ? [expect.objectContaining({ jobId: 'FAKE-455' }), expect.any(Object), { apply }]
      : ['FAKE-455', { apply }]));
    assertSafe(out.raw, out.report);
  });

  it('also projects dispatch previews that reuse the list collector', async () => {
    const out = await invoke(['dispatch', '--json'], { dispatch: async () => ({
      schema: 'fixture', state: 'healthy', tasks: [task()], dryRun: true, sent: 0, replied: 0,
    }) });
    expect(out.code).toBe(0);
    expect(out.report).toMatchObject({ dryRun: true, sent: 0, replied: 0 });
    assertSafe(out.raw, out.report);
  });

  it('retains absent receipt/result and a queued state without inventing execution', async () => {
    const queued = { ...task(), state: 'queued' as const, attemptedAt: undefined, receipt: undefined, result: null };
    const out = await invoke(['list', '--json'], { list: () => ({ schema: 'fixture', state: 'healthy', tasks: [queued] }) });
    expect(out.code).toBe(0);
    expect(out.report.tasks[0]).toMatchObject({ state: 'queued', result: null });
    expect(out.report.tasks[0]).not.toHaveProperty('receipt');
    expect(out.report.tasks[0]).not.toHaveProperty('attemptedAt');
  });

  it.each(['refused', 'error', 'unavailable'])('retains %s state and exit code', async state => {
    const out = await invoke(['cancel', '--job', 'FAKE-455', '--json'], { cancel: async () => ({
      schema: 'fixture', state, reason: 'Cancellation cannot prove a remote stop',
    }) });
    expect(out.code).toBe(1);
    expect(out.report).toMatchObject({ state, reason: 'Cancellation cannot prove a remote stop' });
  });

  it('preserves explicit error reports and does not expose thrown details', async () => {
    const failed = await invoke(['list', '--json'], { list: () => ({
      schema: 'fixture', state: 'healthy', ok: false, error: 'Operation refused', tasks: [],
    }) });
    expect(failed.code).toBe(1);
    expect(failed.report).toMatchObject({ ok: false, error: 'Operation refused' });
    const thrown = await invoke(['list', '--json'], { list: () => { throw new Error(privateFields.token); } });
    expect(thrown.code).toBe(1);
    expect(thrown.report).toEqual({ error: 'Teammate task operation unavailable; check configuration and task state.' });
    expect(thrown.raw).not.toContain('FAKE_PRIVATE_');
  });

  it('fails closed for an object injected into an allowed scalar field', async () => {
    const malformed = { ...task(), result: { ...result, evidence: privateFields } };
    const out = await invoke(['list', '--json'], {
      list: (() => ({ schema: 'fixture', state: 'healthy', tasks: [malformed] })) as unknown as FleetImessageTasksDeps['list'],
    });
    expect(out.code).toBe(1);
    expect(out.raw).not.toContain('FAKE_PRIVATE_');
    expect(out.report).not.toHaveProperty('tasks');
  });

  it('keeps peer declarations distinct from observed peer-reported evidence', async () => {
    const peers = { schema: 'fixture', peers: [{ peer: 'dot', resource: 'imsg:dot',
      declaredEvidence: 'owner-described', observed: [{ kind: 'research', jobId: 'FAKE-455',
        rowid: result.rowid, at: result.at, evidence: 'peer-reported' }] }] };
    const out = await invoke(['peers', '--json'], { peers: (() => peers) as unknown as FleetImessageTasksDeps['peers'] });
    expect(out.code).toBe(0);
    expect(out.report).toEqual(peers);
  });
});
