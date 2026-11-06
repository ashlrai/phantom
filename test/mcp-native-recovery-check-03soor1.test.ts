import { afterEach, describe, expect, it, vi } from 'vitest';
import { callNativeTool, listNativeTools } from '../src/core/mcp-native.js';
import * as recoveryInvocations from '../src/core/fleet/apps-recovery-invocations.js';
import * as recoveryVerdict from '../src/core/fleet/apps-recovery-verdict.js';

const name = 'phantom_fleet_apps_recovery_check';
const validUuid = '550e8400-e29b-41d4-a716-446655440000';

// Fake invocation row builder
function fakeRow(invocationId: string, opts: {
  latestTime?: number; retainedHealthy?: boolean | null;
  retainedObservedRunning?: boolean; retainedDiagnosticsRunning?: boolean;
  terminalOutcome?: string;
} = {}): ReturnType<typeof recoveryInvocations.readAppsRecoveryInvocations>['invocations'][0] {
  const latestTime = opts.latestTime ?? Date.now();
  const retainedHealthy = opts.retainedHealthy ?? true;
  const retainedObservedRunning = opts.retainedObservedRunning ?? true;
  const diagnosticsRunning = opts.retainedDiagnosticsRunning ?? true;
  return {
    invocationId,
    latestCursor: 42,
    latestTime,
    observedApps: ['appA'],
    retainedObservedState: [{ app: 'appA', observedRunning: retainedObservedRunning }],
    retainedDiagnostics: diagnosticsRunning ? [{ app: 'appA', outcome: 'running' }] : null,
    retainedHealthy,
    recoveries: 0,
    consecutiveFailures: 0,
    totalFailedCycles: 0,
    terminalOutcome: opts.terminalOutcome ?? null,
  };
}

afterEach(() => vi.restoreAllMocks());

function fakeProjection(invocations: ReturnType<typeof recoveryInvocations.readAppsRecoveryInvocations>['invocations'] = [], opts: {
  truncated?: boolean; availability?: string;
} = {}): ReturnType<typeof recoveryInvocations.readAppsRecoveryInvocations> {
  return { v: 1, availability: opts.availability ?? 'available', truncated: opts.truncated ?? false,
    scanCursor: 100, scannedEvents: 10, invocations };
}

describe('phantom_fleet_apps_recovery_check', () => {
  // ── 1. Tool discovery ─────────────────────────────────────────────────
  it('is advertised by listNativeTools with a closed read-only schema', () => {
    const tool = listNativeTools().find(t => t.name === name);
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toEqual({
      type: 'object',
      properties: {
        invocationId: {
          type: 'string',
          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        },
        maxAgeMs: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
      required: ['invocationId', 'maxAgeMs'],
      additionalProperties: false,
    });
  });

  // ── 2. Closed schema: reject unknown fields, arrays, null, missing ────
  it.each([
    { args: { invocationId: validUuid, maxAgeMs: 60000, extra: true }, desc: 'extra field' },
    { args: { invocationId: validUuid }, desc: 'missing maxAgeMs' },
    { args: { maxAgeMs: 60000 }, desc: 'missing invocationId' },
    { args: {}, desc: 'empty object' },
    { args: null, desc: 'null arg' },
    { args: [], desc: 'array arg' },
    { args: { invocationId: null, maxAgeMs: 60000 }, desc: 'null invocationId' },
    { args: { invocationId: validUuid, maxAgeMs: null }, desc: 'null maxAgeMs' },
    { args: { invocationId: validUuid, maxAgeMs: 'bad' }, desc: 'string maxAgeMs' },
    { args: { invocationId: 'not-uuid', maxAgeMs: 60000 }, desc: 'bad uuid pattern' },
    { args: { invocationId: validUuid, maxAgeMs: 0 }, desc: 'maxAgeMs=0' },
    { args: { invocationId: validUuid, maxAgeMs: -1 }, desc: 'negative maxAgeMs' },
  ])('rejects malformed input: $desc', async ({ args }) => {
    const result = await callNativeTool(name, args as any);
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain('phantom_fleet_apps_recovery_check');
  });

  // ── 3. Malformed input makes ZERO reader/verdict calls ────────────────
  it('malformed args make zero reader calls', async () => {
    const readerSpy = vi.spyOn(recoveryInvocations, 'readAppsRecoveryInvocations');
    const verdictSpy = vi.spyOn(recoveryVerdict, 'appsRecoveryVerdict');
    const badIds = [null, [], 'not-a-uuid', '550e8400-e29b-XXXX-a716-446655440000', { extra: 1 }];
    for (const bad of badIds) {
      await callNativeTool(name, bad as any);
    }
    expect(readerSpy).not.toHaveBeenCalled();
    expect(verdictSpy).not.toHaveBeenCalled();
  });

  // ── 4. Read safety: callNativeTool rejects arguments before reading ───
  it('rejects arguments before reading (read safety)', async () => {
    const readerSpy = vi.spyOn(recoveryInvocations, 'readAppsRecoveryInvocations');
    for (const args of [{ extra: 1 }, null, []]) {
      expect((await callNativeTool(name, args)).isError).toBe(true);
    }
    expect(readerSpy).not.toHaveBeenCalled();
  });

  // ── 5. Reader exception yields bounded generic error ──────────────────
  it('returns a generic bounded error when reader throws (no raw paths)', async () => {
    const readerSpy = vi.spyOn(recoveryInvocations, 'readAppsRecoveryInvocations');
    readerSpy.mockRejectedValue(new Error('ENOENT: /fake/.ashlr-runs/history.jsonl: child stderr leaked'));
    const result = await callNativeTool(name, { invocationId: validUuid, maxAgeMs: 60000 });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.error).toBe('Recovery check unavailable');
    expect(body.error).not.toContain('.ashlr-runs');
    expect(body.error).not.toContain('child stderr');
  });

  // ── 6. Direct reader/verdict tests (happy-path behaviors) ─────────────
  it.each([
    { label: 'fresh healthy', row: fakeRow(validUuid, { latestTime: Date.now() - 1000 }), expected: 'healthy' as const },
    { label: 'stale', row: fakeRow(validUuid, { latestTime: Date.now() - 120000 }), expected: 'stale' as const },
    { label: 'terminal completed', row: fakeRow(validUuid, { terminalOutcome: 'completed' }), expected: 'terminal' as const },
    { label: 'terminal failed', row: fakeRow(validUuid, { terminalOutcome: 'failed' }), expected: 'terminal' as const },
    { label: 'unhealthy', row: fakeRow(validUuid, { retainedHealthy: false }), expected: 'unhealthy' as const },
    { label: 'unknown (missing)', row: fakeRow('other-uuid-00-0000-0000-000000000000'), expected: 'unknown' as const },
    { label: 'unknown (unavailable)', row: [], expected: 'unknown' as const },
  ])('verdict for $label returns $expected', ({ row, expected }) => {
    const proj = row.length === 0
      ? fakeProjection([], { availability: 'unavailable' })
      : fakeProjection([row]);
    const result = recoveryVerdict.appsRecoveryVerdict(
      proj, validUuid, 60000, Date.now(),
    );
    expect(result.verdict).toBe(expected);
  });

  it('includes truncated flag when projection is truncated', () => {
    const proj = fakeProjection([fakeRow(validUuid)], { truncated: true });
    const result = recoveryVerdict.appsRecoveryVerdict(proj, validUuid, 60000, Date.now());
    expect(result.truncated).toBe(true);
  });

  it('handles unknown invocation with real verdict function', () => {
    const proj = fakeProjection([fakeRow('other-id', { latestTime: Date.now() })]);
    const result = recoveryVerdict.appsRecoveryVerdict(proj, validUuid, 60000, Date.now());
    expect(result.verdict).toBe('unknown');
    // Real function returns structured verdict with invocationId
    expect(result.invocationId).toBe(validUuid);
  });

  it('returns real healthy verdict without mocking', () => {
    const proj = fakeProjection([fakeRow(validUuid, { latestTime: Date.now() })]);
    const result = recoveryVerdict.appsRecoveryVerdict(proj, validUuid, 60000, Date.now());
    expect(result.verdict).toBe('healthy');
    expect(result).toHaveProperty('latestCursor');
    expect(result).toHaveProperty('ageMs');
    expect(result).toHaveProperty('terminalOutcome');
  });
});
