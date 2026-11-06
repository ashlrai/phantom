import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const access = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>();
  const guard = (p: unknown) => {
    const value = String(p);
    access.paths.push(value);
    if (value.split('/').includes('.codex')) throw new Error('forbidden account access');
  };
  return {
    ...real,
    readdirSync: (...args: Parameters<typeof real.readdirSync>) => { guard(args[0]); return real.readdirSync(...args); },
    openSync: (...args: Parameters<typeof real.openSync>) => { guard(args[0]); return real.openSync(...args); },
    lstatSync: (...args: Parameters<typeof real.lstatSync>) => { guard(args[0]); return real.lstatSync(...args); },
    realpathSync: (...args: Parameters<typeof real.realpathSync>) => { guard(args[0]); return real.realpathSync(...args); },
  };
});
vi.mock('../src/core/observability/codex-source.js', () => ({
  readCodexRateLimits: () => { throw new Error('wrong account reader'); },
}));
vi.mock('../src/core/fabric/usage-api.js', () => ({ fetchClaudeUsageApi: () => { throw new Error('provider probe'); } }));

import { clearBackoff, getBackendResourceState, getResourceSnapshot, recordBackoff } from '../src/core/fabric/resource-monitor.js';
import { buildCodexResourceReport, collectCodexSessionUsages } from '../src/core/fleet/codex-session-usage.js';

const start = Date.parse('2036-10-31T16:02:00Z');
const cfg = { foundry: { allowedBackends: ['codex'] } };
let root: string;
let home: string;
function rollout(pct = 20.5, secondary = 30.5, at = Date.now(), extra = {}, selected = home) {
  const dir = join(selected, 'sessions', '2036', '10', '31');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rollout-fake.jsonl'), JSON.stringify({
    timestamp: new Date(at).toISOString(), type: 'event_msg', payload: {
      type: 'token_count', rate_limits: {
        limit_id: 'codex', primary: { used_percent: pct, window_minutes: 300, resets_at: start / 1000 - 1 },
        secondary: { used_percent: secondary, window_minutes: 10080, resets_at: start / 1000 - 1 },
        ...extra,
      },
    },
  }) + '\n');
}
async function block(reason = 'quota exhausted') {
  rollout(100, 100);
  await getBackendResourceState('codex', cfg);
  recordBackoff('codex', 7 * 86400000, reason);
  vi.setSystemTime(start + 60000);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  root = mkdtempSync(join(realpathSync(tmpdir()), 'codex-recovery-fake-'));
  home = join(root, 'personal');
  vi.stubEnv('CODEX_HOME_ALT', home);
  vi.stubEnv('CODEX_HOME', join(root, '.codex'));
  access.paths.length = 0;
  clearBackoff('codex');
});
afterEach(() => {
  expect(access.paths.some(p => p.split('/').includes('.codex'))).toBe(false);
  clearBackoff('codex');
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('personal Codex measured quota recovery', () => {
  it('recovers on the next normal snapshot cycle and reports the measured percentage', async () => {
    await block();
    const blocked = await getResourceSnapshot(cfg);
    rollout();
    expect(await getResourceSnapshot(cfg)).toBe(blocked);
    vi.setSystemTime(start + 91000);
    const recovered = await getResourceSnapshot(cfg);
    const state = recovered.backends.find(b => b.backend === 'codex');
    const report = buildCodexResourceReport(collectCodexSessionUsages({
      env: { CODEX_HOME: home, CODEX_HOME_ALT: home },
    }), [], Date.now());
    expect(state).toMatchObject({ availability: 'open', usedPct: report.resources[0]?.weekly?.usedPct, backoffUntilMs: null });
    expect(state?.usedPct).toBe(30.5);
  });

  it.each([
    ['primary exhausted', 100, 5, 60000, {}],
    ['secondary exhausted', 5, 100, 60000, {}],
    ['older reading', 5, 10, -1, {}],
    ['equal timestamp', 5, 10, 0, {}],
    ['stale reading', 5, 10, -2 * 86400000, {}],
    ['future reading', 5, 10, 120000, {}],
    ['denial', 5, 10, 60000, { rate_limit_reached_type: 'rate_limit_reached' }],
    ['spend control', 5, 10, 60000, { spend_control_reached: true }],
    ['individual exhausted', 5, 10, 60000, { individual_limit: { remaining_percent: 0 } }],
  ])('retains backoff for %s', async (_label, primary, secondary, offset, extra) => {
    await block();
    rollout(primary, secondary, start + offset, extra);
    expect(await getBackendResourceState('codex', cfg)).toMatchObject({ availability: 'exhausted', backoffUntilMs: start + 7 * 86400000 });
  });

  it.each(['authentication failed', 'operator hold', 'network error', 'unknown failure'])('retains %s', async reason => {
    await block(reason);
    rollout();
    expect((await getBackendResourceState('codex', cfg)).availability).toBe('exhausted');
  });

  it('does not clear a backoff belonging to another home', async () => {
    await block();
    const other = join(root, 'other-personal');
    vi.stubEnv('CODEX_HOME_ALT', other);
    rollout(5, 10, Date.now(), {}, other);
    expect((await getBackendResourceState('codex', cfg)).availability).toBe('exhausted');
  });

  it('does not clear an unattributed backoff', async () => {
    recordBackoff('codex', 86400000, 'quota exhausted', { home: 'relative', cause: 'quota' });
    vi.setSystemTime(start + 60000);
    rollout();
    expect((await getBackendResourceState('codex', cfg)).availability).toBe('exhausted');
  });

  it.each(['cmp', 'symlink', 'parent alias'])('rejects unsafe %s configuration before collecting', async mode => {
    rollout();
    const unsafe = mode === 'cmp' ? join(root, '.codex')
      : mode === 'parent alias' ? `${home}/../personal` : join(root, 'alias');
    if (mode === 'symlink') symlinkSync(home, unsafe);
    vi.stubEnv('CODEX_HOME_ALT', unsafe);
    expect((await getBackendResourceState('codex', cfg)).availability).toBe('unknown');
  });

  it('preserves an operator override despite newer headroom', async () => {
    await block();
    rollout();
    const overridden = { foundry: { ...cfg.foundry, resourceOverrides: {
      codex: { availability: 'exhausted', reason: 'operator hold' },
    } } };
    expect((await getBackendResourceState('codex', overridden)).availability).toBe('exhausted');
    expect((await getBackendResourceState('codex', overridden)).reason).toContain('operator hold');
  });

  it('reports the maximum applicable window without a backoff', async () => {
    rollout(100, 5);
    expect(await getBackendResourceState('codex', cfg)).toMatchObject({ availability: 'exhausted', usedPct: 100, capWindow: '5h' });
  });
});
