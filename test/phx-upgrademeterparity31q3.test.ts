import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../examples/upgrade/personal-meter-parity.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

const now = Math.floor(Date.now() / 1000) * 1000;
const at = new Date(now - 60_000).toISOString();
const reset = new Date(now + 7 * 86_400_000).toISOString();
const roots: string[] = [];
const ledger = () => ({ v: 1, lanes: [{ lane: 'codex-personal', window: 'weekly', usedPct: 85, resetAt: reset,
  source: 'codex-personal-sessions', observation: { source: 'codex-personal-sessions', asOf: at } }] });
const personal = () => ({ v: 'resource.v1', resources: [{ id: 'codex-personal', state: 'current', observedAt: at,
  weekly: { kind: 'weekly', usedPct: 85, resetsAt: reset }, session: { usedPct: 99 }, model: 'fake-private-rollout' }] });

async function check(l: unknown, p: unknown, code = 0) {
  const output: string[] = [];
  const read = vi.fn(async (command: 'ledger' | 'personal') => ({ code: command === 'personal' ? code : 0,
    stdout: JSON.stringify(command === 'ledger' ? l : p) }));
  const exit = await run([], { read, now: () => now, write: text => output.push(text) });
  expect(output).toHaveLength(1);
  return { exit, value: JSON.parse(output[0]!), output: output[0]!, read };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('personal meter parity', () => {
  it('compares weekly readings and never emits session or rollout metadata', async () => {
    const result = await check(ledger(), personal());
    expect(result.exit).toBe(0);
    expect(result.value).toEqual({ v: 1, result: 'match', observedAt: at,
      ledger: { usedPct: 85, resetAt: reset }, personal: { usedPct: 85, resetAt: reset } });
    expect(result.output).not.toMatch(/"usedPct":99|fake-private-rollout|session/);
    expect(result.read).toHaveBeenCalledTimes(2);
  });

  it('reports comparable percentage and reset disagreements', async () => {
    const p = personal();
    p.resources[0]!.weekly.usedPct = 84;
    expect(await check(ledger(), p)).toMatchObject({ exit: 1, value: { result: 'mismatch' } });
    p.resources[0]!.weekly.usedPct = 85;
    p.resources[0]!.weekly.resetsAt = new Date(now + 86_400_000).toISOString();
    expect(await check(ledger(), p)).toMatchObject({ exit: 1, value: { result: 'mismatch' } });
  });

  it('compares timestamp instants rather than their spelling', async () => {
    const p = personal();
    p.resources[0]!.observedAt = at.replace('.000Z', 'Z');
    p.resources[0]!.weekly.resetsAt = reset.replace('Z', '+00:00');
    expect((await check(ledger(), p)).exit).toBe(0);
  });

  it('treats missing weekly data, stale, future, and unequal observations as inconclusive', async () => {
    const noWeekly = personal();
    const stale = personal(); stale.resources[0]!.state = 'stale';
    const different = personal(); different.resources[0]!.observedAt = new Date(now - 30_000).toISOString();
    const future = personal(); future.resources[0]!.observedAt = new Date(now + 1000).toISOString();
    const futureLedger = ledger(); futureLedger.lanes[0]!.observation.asOf = future.resources[0]!.observedAt;
    const old = personal(); old.resources[0]!.observedAt = new Date(now - 2 * 86_400_000).toISOString();
    const oldLedger = ledger(); oldLedger.lanes[0]!.observation.asOf = old.resources[0]!.observedAt;
    for (const [l, p] of [[ledger(), { ...noWeekly, resources: [{ ...noWeekly.resources[0], weekly: null }] }],
      [ledger(), stale], [ledger(), different], [futureLedger, future], [oldLedger, old],
      [ledger(), { v: 'resource.v1', resources: [] }]]) {
      expect(await check(l, p)).toMatchObject({ exit: 3, value: { v: 1, result: 'incomparable' } });
    }
    expect((await check(ledger(), stale, 1)).exit).toBe(3);
  });

  it('requires provenance, a known reset, and unambiguous personal rows', async () => {
    const noProvenance = ledger(); noProvenance.lanes[0]!.source = 'status';
    const noReset = personal(); noReset.resources[0]!.weekly.resetsAt = '';
    const duplicate = ledger(); duplicate.lanes.push(duplicate.lanes[0]!);
    for (const [l, p] of [[noProvenance, personal()], [ledger(), noReset], [duplicate, personal()]]) {
      expect((await check(l, p)).exit).toBe(3);
    }
  });

  it('handles help, usage errors and reader failures without leaking errors', async () => {
    const read = vi.fn(async () => { throw new Error('fake-private-path'); });
    const lines: string[] = [];
    const deps = { read, write: (s: string) => lines.push(s) };
    expect(await run(['--help'], deps)).toBe(0);
    expect(await run(['--bad'], deps)).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(await run([], deps)).toBe(1);
    expect(JSON.parse(lines[2]!)).toEqual({ v: 1, error: 'read_failed' });
    expect(lines.join('')).not.toContain('fake-private-path');
    expect(await run([], { ...deps, read: async () => ({ code: 0, stdout: 'bad json' }) })).toBe(1);
  });

  it('uses actual public readers on fake personal JSONL fixtures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fake-meter-parity-')); roots.push(root);
    const runsDir = join(root, 'runs');
    const home = join(root, 'personal');
    const sessions = join(home, 'sessions', '2036', '10', '31');
    await mkdir(join(runsDir, 'queue'), { recursive: true });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(runsDir, 'queue/status.json'), JSON.stringify({ last_tick: new Date(now - 120_000).toISOString(),
      lanes: { 'codex-personal': {} }, budget: { 'codex-personal': { weekly_used_pct: 10 } } }));
    const fixture = (weekly: unknown, observed = at) => JSON.stringify({ timestamp: observed, type: 'event_msg', payload: { type: 'token_count', rate_limits: {
      limit_id: 'fake-private-rollout', primary: { used_percent: 99, window_minutes: 300, resets_at: (now + 3_600_000) / 1000 }, secondary: weekly,
    } } }) + '\n';
    const path = join(sessions, 'rollout-2036-10-31-fake.jsonl');
    const cli = () => new Promise<{ code: number; stdout: string }>((resolveCli, reject) => {
      const script = "import { cmdResourcePersonalUsage } from './src/cli/resource-personal-usage.ts'; process.exitCode = cmdResourcePersonalUsage({ json: true, home: process.argv[1] });";
      execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, home],
        { cwd: process.cwd(), env: { ...process.env, HOME: root }, timeout: 15_000 }, (error, stdout) => {
          if (error && (typeof error.code !== 'number' || error.code !== 1)) return reject(error);
          resolveCli({ code: error ? 1 : 0, stdout });
        });
    });
    const read = async (command: 'ledger' | 'personal') => command === 'personal' ? cli() :
      { code: 0, stdout: JSON.stringify(await readResourceLedger({ runsDir, personalCodexHome: home, now: () => now })) };
    const output: string[] = [];
    const deps = { read, now: () => now, write: (text: string) => output.push(text) };
    await writeFile(path, fixture({ used_percent: 85, window_minutes: 10080, resets_at: Date.parse(reset) / 1000 }));
    expect(await run([], deps)).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ result: 'match', ledger: { usedPct: 85 }, personal: { usedPct: 85 } });
    expect(output.at(-1)).not.toMatch(/"usedPct":99|fake-private-rollout/);
    await writeFile(path, fixture(null));
    expect(await run([], deps)).toBe(3);
    await writeFile(path, fixture({ used_percent: 85, window_minutes: 10080, resets_at: Date.parse(reset) / 1000 }, new Date(now - 2 * 86_400_000).toISOString()));
    expect(await run([], deps)).toBe(3);
  });
});
