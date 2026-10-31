import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/core/integrations/secrets.js', () => ({
  readEnvironmentCredential: vi.fn(() => 'fake-oauth-for-test'),
  resolveProviderKey: vi.fn(() => null),
  explainProviderKey: vi.fn(() => 'test'),
}));

vi.mock('../src/core/observability/codex-source.js', () => ({ readCodexRateLimits: vi.fn(() => null) }));
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({ readDecisions: vi.fn(() => []) }));

const http = vi.fn();
const window = (utilization: number, resets_at = 1900000000) => ({ utilization, resets_at });
const cfg = (resource = {}) => ({ foundry: { claudeResource: resource } });
let home: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'claude-optional-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  vi.stubEnv('CLAUDE_PROJECTS_DIR', join(home, '.claude', 'projects'));
  vi.resetModules(); // isolates API cache, monitor backoff, and CLI event cache
  http.mockReset();
  vi.stubGlobal('fetch', http);
  await import('../src/core/fabric/resource-monitor.js');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
function respond(body: unknown, status = 200) {
  http.mockResolvedValue({ ok: status === 200, status, json: async () => body });
}
async function sense(resource = {}) {
  const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
  return getBackendResourceState('claude', cfg(resource));
}

describe('Claude optional live windows', () => {
  it.each([null, undefined])('keeps weekly-only telemetry with absent five-hour block %s', async absent => {
    respond({ five_hour: absent, seven_day: window(0.46) });
    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    expect(await fetchClaudeUsageApi()).toMatchObject({
      fiveHourPct: null, fiveHourResetAt: null, weeklyPct: 46, weeklyResetAt: 1900000000,
    });
    const state = await sense();
    expect(state).toMatchObject({ availability: 'open', usedPct: 46, capWindow: '7d', resetsAt: 1900000000 });
    expect(state.reason).toContain('weekly: 46%');
    expect(state.reason).not.toMatch(/5h|0%/);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each([
    [null, window(1), 100, '7d', 1900000000, 'exhausted'],
    [window(1), null, 100, '5h', 1900000000, 'exhausted'],
    [window(0.91, 1800000000), window(0.46), 91, '5h', 1800000000, 'throttled'],
    [window(0.46), window(0.91, 1800000000), 91, '7d', 1800000000, 'throttled'],
    [window(0.46, 1800000000), window(0.46), 46, '7d', 1900000000, 'open'],
    [window(0.46), null, 46, '5h', 1900000000, 'open'],
  ])('projects the governing window %#', async (five_hour, seven_day, usedPct, capWindow, resetsAt, availability) => {
    respond({ five_hour, seven_day });
    expect(await sense()).toMatchObject({ usedPct, capWindow, resetsAt, availability });
  });

  it.each([
    {}, { five_hour: null, seven_day: null },
    ...[{}, [], 'bad', window(-0.1), window(NaN), window(Infinity), window(Number.MAX_VALUE),
      window(0.2, NaN), window(0.2, Infinity), window(0.2, -1), window(0.2, 0),
      window(0.2, Number.MAX_VALUE), { utilization: '0.2', resets_at: 1900000000 },
      { utilization: 0.2, resets_at: 'tomorrow' }].flatMap(bad => [
      { five_hour: bad, seven_day: window(0.46) },
      { five_hour: window(0.46), seven_day: bad },
    ]),
  ])('rejects missing or malformed live telemetry %#', async body => {
    respond(body);
    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    expect(await fetchClaudeUsageApi()).toBeNull();
    expect(await sense()).toMatchObject({ availability: 'unknown', usedPct: null });
  });

  it('exposes absent weekly fields as null for five-hour-only data', async () => {
    respond({ five_hour: window(0.1234) });
    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    expect(await fetchClaudeUsageApi()).toMatchObject({ fiveHourPct: 12, weeklyPct: null, weeklyResetAt: null });
    expect((await sense()).reason).not.toContain('weekly:');
  });

  it('retries HTTP 429 only after the existing cache TTL', async () => {
    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    vi.useFakeTimers();
    respond({}, 429);
    expect(await fetchClaudeUsageApi()).toBeNull();
    respond({ seven_day: window(0.46) });
    await vi.advanceTimersByTimeAsync(59999);
    expect(await fetchClaudeUsageApi()).toBeNull();
    expect(http).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await fetchClaudeUsageApi()).toMatchObject({ weeklyPct: 46 });
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('keeps the body-read timeout effective', async () => {
    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    vi.useFakeTimers();
    http.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    const pending = fetchClaudeUsageApi();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBeNull();
    expect(http.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it('keeps configured protectPct effective', async () => {
    respond({ seven_day: window(0.46) });
    expect(await sense({ protectPct: 40 })).toMatchObject({ availability: 'throttled', usedPct: 46 });
  });

  it.each([{ fiveHourMessageCap: 100 }, { fiveHourTokenCap: 100 },
    { weeklyTokenBudget: 100 }, { weeklyCostBudgetUsd: 10 }])('retains explicit local budget fallback %#', async resource => {
    respond({});
    const state = await sense(resource);
    expect(state.cap).toBe(Object.values(resource)[0]);
    expect(state.reason).not.toContain('oauth-usage-api');
  });

  it.each([401, 403, 429])('caches HTTP denial %s without creating headroom', async status => {
    respond({}, status);
    expect(await sense()).toMatchObject({ availability: 'unknown' });
    expect(await sense()).toMatchObject({ availability: 'unknown' });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('preserves fresh provider denial ahead of live headroom', async () => {
    respond({ seven_day: window(0.46) });
    const { recordClaudeRateLimitEventLine } = await import('../src/core/fabric/claude-rate-limit-event.js');
    recordClaudeRateLimitEventLine(JSON.stringify({ type: 'rate_limit_event', status: 'rejected',
      rateLimitType: 'seven_day', utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 }));
    expect(await sense()).toMatchObject({ availability: 'exhausted', capWindow: '7d' });
    expect(http).not.toHaveBeenCalled();
  });

  it('preserves recorded 429 backoff ahead of weekly headroom', async () => {
    respond({ seven_day: window(0.46) });
    const { recordBackoff } = await import('../src/core/fabric/resource-monitor.js');
    recordBackoff('claude', 60000, 'test-429');
    expect(await sense()).toMatchObject({ availability: 'exhausted', usedPct: null });
    expect(http).not.toHaveBeenCalled();
  });
});
