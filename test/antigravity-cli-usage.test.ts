import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdResources } from '../src/cli/resources.js';
import { cmdResourcesPlan } from '../src/cli/resources-plan.js';
import { readAntigravityUsage } from '../src/core/fabric/readers/antigravity-usage.js';
import { resolveExecutable } from '../src/core/run/tool-path.js';
import { runResourceLiveTick } from '../src/core/usage/resource-live/engine.js';
import { buildFleetResourcePlan } from '../src/core/usage/resource-live/fleet-plan.js';
import { defaultResourceLiveSources } from '../src/core/usage/resource-live/sources.js';
import { resourceLivePath } from '../src/core/usage/resource-live/store.js';
import type { ResourceLiveSources } from '../src/core/usage/resource-live/source-types.js';

vi.mock('../src/core/fleet/nodes-view.js', () => ({ defaultNodesViewDeps: () => ({}), readNodesView: () => ({ nodes: [] }) }));
vi.mock('../src/core/fabric/resource-monitor.js', () => ({ getResourceSnapshot: async () => ({}) }));

const firstReset = '2026-12-01T23:15:35Z';
const secondReset = '2026-12-01T23:35:17Z';
const now = Date.parse('2026-12-01T23:13:00Z');
const fixture = {
  status: 'SUCCESS', num_turns: 0, usage: { total_tokens: 0 },
  account_email: 'fixture@example.invalid',
  command: { name: 'usage', data: { description: 'Within each group, models share a weekly limit.',
    groups: [
      { name: 'Gemini Models', description: 'Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash',
        buckets: [{ id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0, reset_time: firstReset }] },
      { name: 'Claude and GPT models', description: 'Models within this group: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B',
        buckets: [{ id: '3p-weekly', window: 'weekly', remaining_fraction: 0, reset_time: secondReset }] },
    ] } },
};
function matching() {
  const raw = structuredClone(fixture);
  raw.command.data.groups[0]!.description = 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Hydrogen';
  return raw;
}
const gui = async () => 'gui-resident' as const;
const resolve = () => ({ path: '/fixture/agy', source: 'path' as const });
const probe = (raw: unknown, model?: string) => readAntigravityUsage(model, {
  context: gui, resolve, run: async () => ({ stdout: JSON.stringify(raw) }),
});
const iso = (s: string) => new Date(s).toISOString();
const ledger = { text: null, truncated: false, missing: true };
const dirs: string[] = [];
async function temp() { const path = await mkdtemp(join(tmpdir(), 'agy-quota-')); dirs.push(path); return path; }
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('official Antigravity /usage', () => {
  it('runs the fixed status-only argv through a fake executable', async () => {
    const dir = await temp();
    const fake = join(dir, process.platform === 'win32' ? 'agy.cjs' : 'agy');
    await writeFile(fake, `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== '["-p","/usage","--output-format","json"]') process.exit(5);\nconsole.log(${JSON.stringify(JSON.stringify(matching()))});\n`, { mode: 0o755 });
    const result = await readAntigravityUsage(undefined, { context: gui,
      ...(process.platform === 'win32' ? {
        resolve: () => ({ path: fake, source: 'path' }),
        run: (path, argv, options) => promisify(execFile)(process.execPath, [path, ...argv], options),
      } : { resolve: name => resolveExecutable(name, { pathValue: dir }) }) });
    expect(result).toEqual({ execution_context: 'gui-resident', reason: null, groups: [
      { name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', window: 'weekly', remaining: 0, reset_at: iso(firstReset) }] },
      { name: 'Claude and GPT models', buckets: [{ id: '3p-weekly', window: 'weekly', remaining: 0, reset_at: iso(secondReset) }] },
    ] });
  });

  it('blocks SSH before execution and does not trust an unproven GUI context', async () => {
    vi.stubEnv('SSH_CONNECTION', 'fixture');
    const run = vi.fn();
    expect(await readAntigravityUsage(undefined, { resolve, run })).toEqual({
      execution_context: 'ssh', groups: null, reason: 'non_gui_context',
    });
    expect(await readAntigravityUsage(undefined, { context: async () => 'unknown', resolve, run })).toMatchObject({
      execution_context: 'unknown', groups: null, reason: 'non_gui_context',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('requires the configured model even when the provider reports both groups at zero', async () => {
    expect(await probe(fixture, 'gemini-4-neon-xhigh')).toEqual({
      execution_context: 'gui-resident', groups: null, reason: 'identity_mismatch',
    });
    expect(await probe(fixture, 'gemini-4-hydrogen-high')).toMatchObject({ reason: null });
  });

  it('clamps fractions, rejects malformed or non-status responses and classifies process failures', async () => {
    const raw = matching();
    raw.command.data.groups[0]!.buckets[0]!.remaining_fraction = -0.25;
    raw.command.data.groups[1]!.buckets[0]!.remaining_fraction = 1.25;
    expect((await probe(raw)).groups?.map(group => group.buckets[0]?.remaining)).toEqual([0, 1]);
    for (const invalid of [{ ...raw, status: 'ERROR' }, { ...raw, num_turns: 1 },
      { ...raw, usage: { total_tokens: 5 } }, { ...raw, command: { name: 'usage', data: { groups: [] } } }]) {
      expect(await probe(invalid)).toMatchObject({ groups: null, reason: 'invalid-reading' });
    }
    expect(await readAntigravityUsage(undefined, { context: gui, resolve, run: async () => ({ stdout: '{' }) }))
      .toMatchObject({ groups: null, reason: 'invalid-reading' });
    expect(await readAntigravityUsage(undefined, { context: gui, resolve: () => null }))
      .toMatchObject({ groups: null, reason: 'no-supported-source' });
    expect(await readAntigravityUsage(undefined, { context: gui, resolve, run: async () => { throw new Error('fixture'); } }))
      .toMatchObject({ groups: null, reason: 'source-error' });
    const timeout = vi.fn(async () => { throw Object.assign(new Error('fixture'), { killed: true, signal: 'SIGKILL' }); });
    expect(await readAntigravityUsage(undefined, { context: gui, resolve, run: timeout }))
      .toMatchObject({ groups: null, reason: 'source-timeout' });
    expect(timeout).toHaveBeenCalledWith('/fixture/agy', ['-p', '/usage', '--output-format', 'json'],
      expect.objectContaining({ timeout: 30_000, shell: false }));
  });

  it('persists only quota and context, sets a zero target until reset, and reports partial and mismatched quota separately', async () => {
    const runsDir = await temp();
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tick = (raw: unknown) => runResourceLiveTick({ runsDir, nowMs: now, force: true, sources: {
      antigravity: defaultResourceLiveSources({ runsDir, antigravityModel: 'gemini-4-neon-xhigh',
        readAntigravity: model => probe(raw, model) }).antigravity,
    } as ResourceLiveSources });

    const { sidecar } = await tick(matching());
    expect(await readFile(resourceLivePath(runsDir), 'utf8')).not.toContain('fixture@example.invalid');
    const withRunning = { schema: 'dispatchd.status.v1', last_tick: new Date(now).toISOString(), lanes: { agy: { running: 2 } } };
    const lane = buildFleetResourcePlan(sidecar, [], withRunning, ledger, now).lanes.find(row => row.lane === 'agy');
    expect(lane).toMatchObject({ running: 2, target_concurrency: 0, additional_slots: 0,
      reason: 'quota_exhausted_until_reset', reset_at: iso(firstReset) });
    expect(await cmdResourcesPlan(['--json', '--runs-dir', runsDir])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({
      antigravity: { execution_context: 'gui-resident', reason: 'quota_exhausted_until_reset', reset_at: iso(firstReset) },
      lanes: expect.arrayContaining([expect.objectContaining({ lane: 'agy', target_concurrency: 0 })]),
    });
    expect(await cmdResources(['--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ antigravity: { groups: expect.arrayContaining([
      { name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', window: 'weekly', remaining: 0, reset_at: iso(firstReset) }] },
    ]) } });
    const after = buildFleetResourcePlan(sidecar, [], {}, ledger, Date.parse(firstReset));
    expect(after.antigravity).toMatchObject({ reset_at: null, reason: null });
    expect(after.antigravity.groups?.map(group => group.buckets[0]?.remaining)).toEqual([null, 0]);
    expect(after.lanes.find(row => row.lane === 'agy')?.target_concurrency).toBeNull();

    const partial = matching();
    partial.command.data.groups[0]!.buckets[0]!.remaining_fraction = 0.625;
    const plan = buildFleetResourcePlan((await tick(partial)).sidecar, [], {}, ledger, now);
    expect(plan.antigravity.groups?.map(group => group.buckets[0]?.remaining)).toEqual([0.625, 0]);
    expect(plan.lanes.find(row => row.lane === 'agy')?.target_concurrency).toBeNull();
    await tick(fixture);
    expect(await cmdResourcesPlan(['--json', '--runs-dir', runsDir])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({
      antigravity: { execution_context: 'gui-resident', reason: 'identity_mismatch', groups: null, reset_at: null },
      lanes: expect.arrayContaining([expect.objectContaining({ lane: 'agy', target_concurrency: null })]),
    });
  });
});
