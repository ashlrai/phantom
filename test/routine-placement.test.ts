import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeRoutine, readRoutineLedger, runRoutine, type Routine } from '../src/core/routines/index.js';
import { buildOpenAICompatibleClient } from '../src/core/run/provider-client.js';
import { runRoutinesCli } from '../src/cli/routines.js';
const engineRun = vi.hoisted(() => vi.fn(async () => ({ state: { status: 'done', usage: { estCostUsd: 0 } } })));
vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({ foundry: { engines: {} } }) }));
vi.mock('../src/core/run/sandboxed-engine.js', () => ({ runEngineSandboxed: engineRun, runApiModelSandboxed: engineRun }));
const botSubmit = vi.hoisted(() => vi.fn(async () => ({ status: 'accepted' })));
vi.mock('../src/core/resources/grokbot/lane.js', () => ({ GrokbotLane: class {
  submit = botSubmit;
  readResult = async () => ({ status: 'succeeded' });
} }));
let home: string;
beforeEach(() => { engineRun.mockClear(); botSubmit.mockClear(); home = mkdtempSync(join(tmpdir(), 'routine-placement-')); vi.stubEnv('HOME', home); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });
const watchdog = (): Routine => ({ id: 'watchdog', goal: 'Check stalled jobs', sourceRepo: '/repo', budgetUsd: 3,
  quotaSince: '2026-01-01T00:00:00Z', resources: [
    { provider: 'local', model: 'local-model', costUsd: 0, latencyMs: 1000, quality: 0.9, freeQuota: 0 },
    { provider: 'codex', model: 'frontier-model', costUsd: 1, latencyMs: 2000, quality: 0.98, freeQuota: 0 },
  ] });
describe('routine placement and execution receipts', () => {
  it('refuses inference redirects away from loopback for chat and streaming', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const client = buildOpenAICompatibleClient('http://127.0.0.1:8000/v1', '', 'local-model', true);
    await client.chat([{ role: 'user', content: 'health check' }]);
    await client.chatStream!([{ role: 'user', content: 'health check' }], undefined, () => {});
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) expect(call[1]).toMatchObject({ redirect: 'error' });
  });
  it('runs the CLI through a pinned credential-free oMLX sandbox adapter', async () => {
    const file = join(home, 'routine.json');
    writeFileSync(file, JSON.stringify(watchdog()));
    expect(await runRoutinesCli(['run', file], () => {})).toBe(0);
    expect(engineRun).toHaveBeenCalledWith('local-coder', 'Check stalled jobs', expect.objectContaining({
      foundry: expect.objectContaining({ engines: expect.objectContaining({
        'local-coder': expect.objectContaining({ api: { envKey: '', defaultBaseUrl: 'http://127.0.0.1:8000/v1', defaultModel: 'local-model', protocol: 'openai' } }),
      }) }),
    }), expect.objectContaining({ sourceRepo: '/repo', model: 'local-model' }));
  });
  it('routes justified Grok escalation through the existing Bot lane', async () => {
    const routine = watchdog();
    routine.minQuality = 0.95;
    routine.resources.push({ provider: 'grok', model: 'bot-model', costUsd: 0, latencyMs: 1000, quality: 1, freeQuota: 1,
      grokbot: { budgetFile: '/snapshot.json', secretsProject: '/project', dayCap: 1, weekCap: 2 } });
    const file = join(home, 'routine.json');
    writeFileSync(file, JSON.stringify(routine));
    expect(await runRoutinesCli(['run', file], () => {})).toBe(0);
    expect(engineRun).not.toHaveBeenCalled();
    expect(botSubmit).toHaveBeenCalledWith(expect.objectContaining({ schema: 'grokbot-task.v1', budget_cap: 1 }));
  });
  it('escalates the actual CLI adapter to Codex after repeated local failures', async () => {
    const file = join(home, 'routine.json');
    writeFileSync(file, JSON.stringify(watchdog()));
    for (let i = 0; i < 4; i++) {
      engineRun.mockResolvedValueOnce({ state: { status: i < 3 ? 'failed' : 'done', usage: { estCostUsd: 0 } } });
      expect(await runRoutinesCli(['run', file], () => {})).toBe(i < 3 ? 1 : 0);
    }
    expect(engineRun.mock.calls.map(call => call[0])).toEqual(['local-coder', 'local-coder', 'local-coder', 'codex']);
  });
  it('defaults watchdog to local, learns repeated failures, runs Codex and explains every choice', async () => {
    const routine = watchdog();
    const providers: string[] = [];
    for (let i = 0; i < 4; i++) {
      await runRoutine(routine, async resource => {
        providers.push(resource.provider);
        return { outcome: resource.provider === 'local' ? 'failed' : 'succeeded', costUsd: resource.costUsd };
      });
    }
    expect(providers).toEqual(['local', 'local', 'local', 'codex']);
    const lines: string[] = [];
    expect(await runRoutinesCli(['explain', 'watchdog'], x => lines.push(x))).toBe(0);
    const rows = JSON.parse(lines[0]!);
    expect(rows[3].decision).toMatchObject({ selected: { provider: 'codex', samples: 0 }, localFailureRate: 1 });
    expect(rows[3].decision.candidates[0].reason).toBe('repeated local failures');
    expect(readRoutineLedger()).toHaveLength(4);
  });
  it('enforces budget after free quota and admits declared quality and latency needs', () => {
    const routine = watchdog();
    routine.minQuality = 0.95;
    expect(placeRoutine(routine, []).selected?.provider).toBe('codex');
    routine.budgetUsd = 0;
    expect(placeRoutine(routine, []).selected).toBeNull();
    routine.resources[1]!.freeQuota = 1;
    expect(placeRoutine(routine, []).selected?.costUsd).toBe(0);
    routine.minQuality = 0;
    routine.resources[0]!.latencyMs = 5000;
    routine.maxLatencyMs = 3000;
    expect(placeRoutine(routine, []).selected?.provider).toBe('codex');
  });
  it('reserves before execution, blocks duplicate runs and records thrown failures', async () => {
    await runRoutine(watchdog(), async () => {
      expect(readRoutineLedger()[0]?.outcome).toBe('running');
      await expect(runRoutine(watchdog(), async () => { throw new Error('must not run'); })).rejects.toThrow('already running');
      throw new Error('local unavailable');
    });
    expect(readRoutineLedger()[0]?.outcome).toBe('failed');
  });
  it('consumes free quota across routines and learns measured quality and speed', async () => {
    const routine = watchdog();
    routine.minQuality = 0.95;
    routine.resources[1]!.freeQuota = 1;
    await runRoutine(routine, async () => ({ outcome: 'succeeded', costUsd: 0 }));
    const other = { ...routine, id: 'manager', budgetUsd: 0 };
    expect(placeRoutine(other, readRoutineLedger()).selected).toBeNull();
    const local = watchdog();
    local.minQuality = 0.8;
    await runRoutine(local, async () => ({ outcome: 'failed', costUsd: 0 }));
    expect(placeRoutine(local, readRoutineLedger()).selected?.provider).toBe('codex');
  });
  it('fails closed on a corrupt ledger before invoking an executor', async () => {
    await runRoutine(watchdog(), async () => ({ outcome: 'succeeded', costUsd: 0 }));
    writeFileSync(join(home, '.ashlr/routines/ledger.json'), '[{"costUsd":-1}]');
    await expect(runRoutine(watchdog(), async () => { throw new Error('must not execute'); })).rejects.toThrow('Invalid routine ledger');
  });
  it('rejects invalid measurements and does not confuse engine completion with merge quality', async () => {
    const routine = watchdog();
    routine.resources[0]!.costUsd = NaN;
    expect(() => placeRoutine(routine, [])).toThrow('Invalid routine');
    routine.resources[0]!.costUsd = 0;
    routine.outcome = 'merge';
    await runRoutine(routine, async () => ({ outcome: 'succeeded', costUsd: 0 }));
    expect(placeRoutine(routine, readRoutineLedger()).candidates[0]!.quality).toBeCloseTo(0.6);
  });
});
