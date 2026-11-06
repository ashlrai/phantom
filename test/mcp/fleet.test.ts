import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDaemonState } from '../../src/core/daemon/state.js';
import { readFleetLoop, readFleetStatus } from '../../src/mcp/fleet.js';

let home: string;
function seed(name: string, value: unknown) {
  const path = join(home, '.ashlr', name);
  mkdirSync(join(home, '.ashlr'), { recursive: true });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'phantom-fleet-mcp-'));
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('local fleet observations', () => {
  it('reads a fresh home without creating config, stores or audit files', async () => {
    const status = await readFleetStatus();
    expect(status).toMatchObject({ authority: 'none', snapshotKind: 'local-persisted',
      daemon: { running: false, liveness: 'stopped', sourceQuality: { reason: 'missing' } },
      queue: { sourceState: 'unavailable', backlogItems: null },
      proposals: { pending: 0, sourceQuality: { sourceState: 'missing', complete: true } },
    });
    expect(readdirSync(home)).toEqual([]);
  });

  it('returns cached queue inventory and configured backend quota without probing providers', async () => {
    seed('config.json', { foundry: { allowedBackends: ['builtin'] }, daemon: { dailyBudgetUsd: 3 } });
    seed('backlog.json', { generatedAt: '2026-10-25T12:00:00.000Z', repos: ['/private/repo'], items: [{}, {}] });
    const status = await readFleetStatus();
    expect(status.queue).toEqual({ sourceState: 'available', generatedAt: '2026-10-25T12:00:00.000Z', backlogItems: 2, repos: 1 });
    expect(status.backends).toEqual([{ backend: 'builtin', quota: 'unlimited', sourceQuality: 'unlimited' }]);
    expect(status.budget.dailyBudgetUsd).toBe(3);
    expect(JSON.stringify(status)).not.toContain('/private/repo');
    expect(readdirSync(join(home, '.ashlr')).sort()).toEqual(['backlog.json', 'config.json']);
  });

  it('bounds tick history, preserves order, and projects only permitted tick fields', async () => {
    seed('daemon.json', { ...freshDaemonState(), itemsProcessed: 9,
      ticks: [1, 2, 3].map(n => ({ ts: `2026-10-25T12:00:0${n}.000Z`, itemsConsidered: n,
        proposalsCreated: 0, spentUsd: 0, reason: `tick-${n}`, secret: 'private-value', dispatches: [{ argv: 'private' }] })),
    });
    const loop = await readFleetLoop(2);
    expect(loop.recentTicks?.map(t => t.reason)).toEqual(['tick-2', 'tick-3']);
    expect(loop.historyTruncated).toBe(true);
    expect(loop.daemon.itemsProcessed).toBe(9);
    expect(JSON.stringify(loop)).not.toContain('private-value');
    expect(JSON.stringify(loop)).not.toContain('dispatches');
  });

  it.each([0, -1, 51, 1.5, NaN])('rejects invalid history limit %s', async limit => {
    await expect(readFleetLoop(limit)).rejects.toThrow(RangeError);
    expect(readdirSync(home)).toEqual([]);
  });

  it('withholds malformed nested tick fields instead of exporting arbitrary data', async () => {
    seed('daemon.json', { ...freshDaemonState(), ticks: [{
      ts: '2026-10-25T12:00:00.000Z', reason: { privateValue: 'opaque' },
      itemsConsidered: {}, proposalsCreated: -1, spentUsd: 'private', dryRun: {},
      backends: { builtin: 2, codex: { privateValue: 'opaque' }, arbitrary: 9 },
    }] });
    const loop = await readFleetLoop();
    expect(loop.recentTicks?.[0]).toMatchObject({ reason: null, itemsConsidered: null,
      proposalsCreated: null, spentUsd: null, dryRun: null, backends: { builtin: 2 } });
    expect(JSON.stringify(loop)).not.toContain('opaque');
    expect(JSON.stringify(loop)).not.toContain('arbitrary');
  });

  it('reports unknown evidence for corrupt state and preserves the original bytes', async () => {
    const path = seed('daemon.json', 'invalid state');
    const before = readFileSync(path, 'utf8');
    const loop = await readFleetLoop();
    expect(loop.daemon).toMatchObject({ running: null, liveness: 'unknown', itemsProcessed: null,
      sourceQuality: { sourceState: 'degraded', complete: false, reason: 'malformed' } });
    expect(loop.budget.spentTodayUsd).toBeNull();
    expect(loop.recentTicks).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(join(home, '.ashlr'))).toEqual(['daemon.json']);
  });

  it('distinguishes a stale recorded running claim from live daemon evidence', async () => {
    const path = seed('daemon.json', { ...freshDaemonState(), running: true, pid: 2_147_483_647 });
    const before = readFileSync(path, 'utf8');
    const loop = await readFleetLoop();
    expect(loop.daemon).toMatchObject({ recordedRunning: true, running: false, liveness: 'stale', pid: null });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('does not manufacture proposal counts from an incomplete inbox', async () => {
    const inbox = join(home, '.ashlr', 'inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'bad.json'), '{');
    const status = await readFleetStatus();
    expect(status.proposals.sourceQuality.complete).toBe(false);
    expect(status.proposals.pending).toBeNull();
    expect(status.proposals.applied).toBeNull();
  });

  it('remains observable under KILL and a daemon pause without clearing either', async () => {
    seed('KILL', {});
    seed('daemon.paused', { pausedAt: '2026-10-25T12:00:00.000Z', by: 'cli' });
    const status = await readFleetStatus();
    expect(status.killSwitch.state).toBe('active');
    expect(status.pause.state).toBe('paused');
    expect(existsSync(join(home, '.ashlr', 'KILL'))).toBe(true);
    expect(readdirSync(join(home, '.ashlr')).sort()).toEqual(['KILL', 'daemon.paused']);
    expect(JSON.stringify(status)).not.toContain(home);
  });

  it('refuses corrupt config instead of repairing or silently replacing it', async () => {
    const path = seed('config.json', 'bad config');
    const before = readFileSync(path, 'utf8');
    await expect(readFleetStatus()).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(join(home, '.ashlr'))).toEqual(['config.json']);
  });

  it.each([
    { allowedBackends: [{ privateValue: 'opaque' }] },
    { allowedBackends: 'codex' },
    { allowedBackends: ['unknown-backend'] },
  ])(
    'refuses malformed backend configuration $allowedBackends without reflecting it', async ({ allowedBackends }) => {
      seed('config.json', { foundry: { allowedBackends } });
      await expect(readFleetStatus()).rejects.toThrow('Invalid configured fleet backends.');
    },
  );
});
