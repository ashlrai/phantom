import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runResourceLiveTick } from '../src/core/usage/resource-live/engine.js';
import { projectResourceLiveFeed } from '../src/core/usage/resource-live/feed.js';
import { defaultResourceLiveSources } from '../src/core/usage/resource-live/sources.js';
import { statusBudgetSource, ultraReadingSource } from '../src/core/usage/resource-live/fleet-sources.js';

const roots: string[] = [];
const now = Date.parse('2026-11-24T07:00:00.000Z');
function fixture() { const root = mkdtempSync(join(tmpdir(), 'fleet-sources-')); roots.push(root); mkdirSync(join(root, 'queue')); mkdirSync(join(root, 'state')); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('reads a measured status budget without refreshing its observation timestamp', async () => {
  const root = fixture(), path = join(root, 'queue/status.json');
  const row = { weekly_used_pct: 0, reset_at: '2026-11-25T00:00:00Z', observed_at: '2026-11-24T05:00:00Z', source: 'reader-cmp' };
  writeFileSync(path, JSON.stringify({ budget: { 'codex-cmp': row } }));
  expect(await statusBudgetSource(root, 'codex-cmp').read(now)).toMatchObject({ used: 0, limit: 100, observed_at: '2026-11-24T05:00:00.000Z', source: 'status-budget:reader-cmp' });
  writeFileSync(path, JSON.stringify({ budget: { 'codex-cmp': { ...row, source: 'untrusted' } } }));
  expect(await statusBudgetSource(root, 'codex-cmp').read(now)).toBeNull();
  writeFileSync(path, JSON.stringify({ budget: { 'codex-cmp': { ...row, estimated: true } } }));
  expect(await statusBudgetSource(root, 'codex-cmp').read(now)).toBeNull();
  writeFileSync(path, JSON.stringify({ budget: { 'codex-cmp': { ...row, weekly_used_pct: 101 } } }));
  expect(await statusBudgetSource(root, 'codex-cmp').read(now)).toBeNull();
});
it('accepts measured Grok points and rejects impossible or missing readings', async () => {
  const root = fixture(), path = join(root, 'state/grok-ultra.reading.json');
  const source = ultraReadingSource(root, 'state/grok-ultra.reading.json');
  expect(await source.read(now)).toBeNull();
  writeFileSync(path, JSON.stringify({ remainingPoints: 30, totalPoints: 100, timestamp: '2026-11-24T06:00:00Z' }));
  expect(await source.read(now)).toMatchObject({ used: 70, limit: 100, unit: 'points', reset_at: null });
  writeFileSync(path, JSON.stringify({ remainingPoints: 101, totalPoints: 100, timestamp: '2026-11-24T06:00:00Z' }));
  expect(await source.read(now)).toBeNull();
});

it('projects the dispatcher reading through the live tick into a sensor', async () => {
  const root = fixture();
  writeFileSync(join(root, 'queue/status.json'), JSON.stringify({ budget: { 'codex-cmp': {
    weekly_used_pct: 0, reset_at: '2026-11-25T00:00:00Z', observed_at: '2026-11-24T06:50:00Z', source: 'reader-cmp',
  } } }));
  const sources = defaultResourceLiveSources({ runsDir: root, fetchImpl: async () => new Response(null, { status: 503 }),
    readClaudeQuota: async () => null, readClaudeEvent: () => null });
  const { sidecar } = await runResourceLiveTick({ runsDir: root, sources, nowMs: now, force: true, deadlineMs: 100 });
  expect(sidecar.readings.find(row => row.id === 'codex-cmp')).toMatchObject({ used: 0, source: 'status-budget:reader-cmp' });
  expect(projectResourceLiveFeed(sidecar, now).readings).toContainEqual(expect.objectContaining({
    lane: 'codex-cmp', used: 0, limit: 100, source: 'dispatcher-budget', observedAt: '2026-11-24T06:50:00.000Z',
  }));
});
