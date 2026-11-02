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
  home = mkdtempSync(join(tmpdir(), 'claude-weekly-governs-'));
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

describe('Claude weekly window governs over five_hour', () => {
  it('lets weekly headroom open work when five_hour reads high', async () => {
    respond({ five_hour: window(0.91, 1800000000), seven_day: window(0.46) });
    const state = await sense();
    expect(state).toMatchObject({ availability: 'open', usedPct: 46, capWindow: '7d', resetsAt: 1900000000 });
    expect(state.reason).toContain('weekly: 46%');
    expect(state.reason).toContain('5h: 91% (not governing)');
  });

  it('stays open, not exhausted, when five_hour is saturated but weekly is not', async () => {
    respond({ five_hour: window(1), seven_day: window(0.46) });
    const state = await sense();
    expect(state.availability).toBe('open');
    expect(state.availability).not.toBe('exhausted');
    expect(state).toMatchObject({ usedPct: 46, capWindow: '7d' });
  });

  it('still throttles when the weekly reading crosses protectPct', async () => {
    respond({ five_hour: window(0.10), seven_day: window(0.91) });
    const state = await sense();
    expect(state).toMatchObject({ availability: 'throttled', usedPct: 91, capWindow: '7d' });
  });

  it('reports exhausted under the weekly window when both readings are saturated', async () => {
    respond({ five_hour: window(1), seven_day: window(1) });
    const state = await sense();
    expect(state).toMatchObject({ availability: 'exhausted', usedPct: 100, capWindow: '7d' });
  });

  it('keeps five_hour authoritative when no weekly reading exists', async () => {
    respond({ five_hour: window(1) });
    const state = await sense();
    expect(state).toMatchObject({ availability: 'exhausted', usedPct: 100, capWindow: '5h' });
  });

  it('lets a fresh rejected five_hour CLI event stop work without an OAuth fetch', async () => {
    respond({ five_hour: window(0.91), seven_day: window(0.46) });
    const { recordClaudeRateLimitEventLine } = await import('../src/core/fabric/claude-rate-limit-event.js');
    recordClaudeRateLimitEventLine(JSON.stringify({ type: 'rate_limit_event', status: 'rejected',
      rateLimitType: 'five_hour', utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 1800 }));
    const state = await sense();
    expect(state).toMatchObject({ availability: 'exhausted', capWindow: '5h' });
    expect(http).not.toHaveBeenCalled();
  });
});
