import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearBackoff, getBackendResourceState } from '../src/core/fabric/resource-monitor.js';
import { invalidateUsageApiCache } from '../src/core/fabric/usage-api.js';
import { recordClaudeRateLimitEventLine } from '../src/core/fabric/claude-rate-limit-event.js';

const readings = vi.hoisted(() => ({ used: 0 }));
vi.mock('../src/core/integrations/secrets.js', () => ({
  readEnvironmentCredential: vi.fn(() => 'fake-oauth-for-test'),
  resolveProviderKey: vi.fn(() => null),
  explainProviderKey: vi.fn(() => 'test'),
}));
vi.mock('../src/core/fabric/claude-usage.js', () => ({
  readClaudeUsage: () => ({ tokens5h: readings.used, messages5h: readings.used,
    messages7d: readings.used, tokens7d: readings.used, filesScanned: 1, readAt: Date.now() }),
}));
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: () => [{ engine: 'claude', tokensIn: readings.used, tokensOut: 0, costUsd: readings.used }],
}));

let home: string;
const http = vi.fn();
const cfg = (resource = {}) => ({ foundry: { claudeResource: resource } });

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'no-auto-reserve-391-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  vi.stubEnv('CODEX_HOME_ALT', join(home, 'fake-personal'));
  clearBackoff('claude');
  clearBackoff('codex');
  invalidateUsageApiCache();
  readings.used = 0;
  http.mockReset().mockResolvedValue({ ok: false, status: 503 });
  vi.stubGlobal('fetch', http);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe.each(['oauth', 'cli', 'transcript', 'fleet tokens', 'fleet cost', 'stats'])('Claude %s reserve policy', source => {
  it.each([
    [90, undefined, 'near'],
    [90, 85, 'throttled'],
    [100, undefined, 'exhausted'],
  ] as const)('at %s percent with protectPct=%s reports %s', async (used, protectPct, availability) => {
    readings.used = used;
    const reset = Math.floor(Date.now() / 1000) + 3600;
    let resource: Record<string, number> = {};
    let capWindow = '7d';
    let reasonSource: string;
    switch (source) {
      case 'oauth':
        http.mockResolvedValue({ ok: true, status: 200, json: async () => ({
          five_hour: { utilization: 0.1, resets_at: reset },
          seven_day: { utilization: used / 100, resets_at: reset },
        }) });
        reasonSource = 'source=oauth-usage-api';
        break;
      case 'cli':
        recordClaudeRateLimitEventLine(JSON.stringify({ type: 'rate_limit_event',
          status: 'allowed_warning', rateLimitType: 'seven_day', utilization: used / 100, resetsAt: reset }));
        reasonSource = 'source=claude-cli-rate_limit_event';
        break;
      case 'transcript':
        resource = { fiveHourTokenCap: 100 };
        capWindow = '5h';
        reasonSource = 'configured local transcript budget';
        break;
      case 'fleet tokens':
        resource = { weeklyTokenBudget: 100 };
        reasonSource = 'fleet 7d claude spend vs budget';
        break;
      case 'fleet cost':
        resource = { weeklyCostBudgetUsd: 100 };
        reasonSource = 'fleet 7d claude spend vs budget';
        break;
      default:
        resource = { weeklyMessageCap: 100 };
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'stats-cache.json'), JSON.stringify({
          lastComputedDate: new Date().toISOString(),
          dailyActivity: [{ date: new Date().toISOString().slice(0, 10), messageCount: used }],
        }));
        reasonSource = 'stats-cache fallback';
    }
    const state = await getBackendResourceState('claude', cfg({ ...resource, protectPct }));
    expect(state).toMatchObject({ availability, usedPct: used, capWindow });
    expect(state.reason).toContain(reasonSource);
    if (availability === 'throttled') expect(state.reason).toContain('protectPct=85%');
    else expect(state.reason).not.toContain('protectPct');
  });
});

describe('subscription thresholds without a reserve', () => {
  it.each([74, 75, 85, 98, 99])('keeps Claude at %s percent dispatchable', async used => {
    http.mockResolvedValue({ ok: true, status: 200, json: async () => ({
      seven_day: { utilization: used / 100, resets_at: Math.floor(Date.now() / 1000) + 3600 },
    }) });
    expect(await getBackendResourceState('claude', cfg())).toMatchObject({
      availability: used >= 75 ? 'near' : 'open', usedPct: used,
    });
  });

  it.each([
    [74, {}, 'open'], [75, {}, 'near'], [90, {}, 'near'], [95, {}, 'near'],
    [99, {}, 'near'], [100, {}, 'exhausted'],
    [50, { rate_limit_reached_type: 'rate_limit_reached' }, 'exhausted'],
    [50, { spend_control_reached: true }, 'exhausted'],
    [50, { individual_limit: { remaining_percent: 0 } }, 'exhausted'],
  ] as const)('Codex at %s percent with flags %j reports %s', async (used, extra, availability) => {
    const dir = join(home, 'fake-personal', 'sessions', '2036', '10', '31');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rollout-fake.jsonl'), JSON.stringify({
      timestamp: new Date().toISOString(), type: 'event_msg', payload: {
        type: 'token_count', rate_limits: { limit_id: 'codex',
          primary: { used_percent: used, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          ...extra,
        },
      },
    }) + '\n');
    expect(await getBackendResourceState('codex', cfg())).toMatchObject({ availability, usedPct: used });
  });
});
