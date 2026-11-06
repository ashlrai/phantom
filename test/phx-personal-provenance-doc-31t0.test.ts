import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdResources } from '../src/cli/resources.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

const now = '2036-10-31T12:00:00.000Z';
const observed = '2036-10-31T11:30:00.000Z';
let root: string;
let output: ReturnType<typeof vi.spyOn>;

function session(at: string, weekly: number | null): void {
  const dir = join(root, 'personal', 'sessions', '2036', '10', '31');
  mkdirSync(dir, { recursive: true });
  const window = (used: number, minutes: number, reset: string) => ({
    used_percent: used, window_minutes: minutes, resets_at: Date.parse(reset) / 1000,
  });
  const row = { timestamp: at, type: 'event_msg', payload: { type: 'token_count',
    api_key: 'fake-credential-value', cwd: root, rate_limits: {
      limit_name: 'fake-private-label', primary: window(12, 300, '2036-10-31T16:00:00Z'),
      secondary: weekly === null ? null : window(weekly, 10080, '2036-11-07T11:30:00Z'),
    } } };
  writeFileSync(join(dir, 'rollout-2036-10-31-fake.jsonl'), JSON.stringify(row) + '\n');
}

function status(at: string | null, weekly: number | null): void {
  const dir = join(root, 'runs', 'queue');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ last_tick: at,
    lanes: { 'codex-personal': { running: 1, target: 1 } },
    budget: { 'codex-personal': { weekly_used_pct: weekly, source: 'status' } },
  }));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fake-personal-provenance-')));
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('personal meter provenance', () => {
  it('keeps session and weekly readings distinct and identifies the observation in command and ledger output', async () => {
    session(observed, 46);
    status('2036-10-30T23:45:00Z', 40);
    expect(await cmdResources(['personal', '--home', join(root, 'personal'), '--json'])).toBe(0);
    const machine = String(output.mock.calls.at(-1)![0]);
    const report = JSON.parse(machine);
    expect(report).toMatchObject({ generatedAt: now, resources: [{ id: 'codex-personal', state: 'current', observedAt: observed,
      session: { usedPct: 12, resetsAt: '2036-10-31T16:00:00.000Z' },
      weekly: { usedPct: 46, resetsAt: '2036-11-07T11:30:00.000Z' } }] });
    const ledger = await readResourceLedger({ runsDir: join(root, 'runs'), personalCodexHome: join(root, 'personal'), now: () => Date.parse(now) });
    expect(ledger).toMatchObject({ generatedAt: now, asOf: '2036-10-30T23:45:00Z', lanes: [{ lane: 'codex-personal', running: 1,
      usedPct: 46, source: 'codex-personal-sessions', observation: { asOf: observed } }] });
    for (const text of [machine, JSON.stringify(ledger)]) {
      expect(text).not.toContain(root);
      expect(text).not.toMatch(/"(?:api[_-]?key|access[_-]?token|password|secret)"\s*:|fake-credential-value|fake-private-label/i);
    }
  });

  it('retains newer status or unknown weekly usage when no newer weekly sample exists', async () => {
    session(observed, 46);
    status(now, 48);
    const read = () => readResourceLedger({ runsDir: join(root, 'runs'), personalCodexHome: join(root, 'personal'), now: () => Date.parse(now) });
    expect((await read()).lanes[0]).toMatchObject({ usedPct: 48, source: 'status' });
    session(observed, null);
    status('2036-10-30T23:45:00Z', null);
    expect(await cmdResources(['personal', '--home', join(root, 'personal'), '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).resources[0]).toMatchObject({ observedAt: observed, session: { usedPct: 12 }, weekly: null });
    expect((await read()).lanes[0]).toMatchObject({ running: 1, usedPct: null, source: 'status' });
  });
});
