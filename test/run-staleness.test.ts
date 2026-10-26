import { describe, it, expect, vi, afterEach } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import type { RunState } from '../src/core/types.js';

const runs: RunState[] = [];
vi.mock('../src/core/run/orchestrator.js', () => ({
  listRuns: () => runs,
  loadRun: (id: string) => runs.find((r) => r.id === id) ?? null,
  runGoal: vi.fn(),
}));

import { isStaleRunning, STALE_RUNNING_MS } from '../src/core/run/run-staleness.js';
import { cmdRuns, cmdRun } from '../src/cli/run.js';

function run(id: string, status: RunState['status'], quietMs: number): RunState {
  const updatedAt = new Date(Date.now() - quietMs).toISOString();
  return {
    id, goal: `goal ${id}`, engine: 'builtin', provider: 'ollama',
    createdAt: updatedAt, updatedAt,
    budget: { maxTokens: 1000, maxSteps: 10, maxUsd: 0 } as RunState['budget'],
    usage: { tokensIn: 0, tokensOut: 0 } as RunState['usage'],
    tasks: [], steps: [], status,
  };
}

function captureLog(): { text: () => string } {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  return { text: () => stripVTControlCharacters(lines.join('\n')) };
}

afterEach(() => { runs.length = 0; vi.restoreAllMocks(); });

describe('isStaleRunning', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const at = (ms: number) => new Date(now - ms).toISOString();

  it('flags a running run quiet past the threshold', () => {
    expect(isStaleRunning({ status: 'running', updatedAt: at(STALE_RUNNING_MS + 1) }, now)).toBe(true);
  });
  it('leaves recent running runs and finished runs alone', () => {
    expect(isStaleRunning({ status: 'running', updatedAt: at(STALE_RUNNING_MS - 1000) }, now)).toBe(false);
    expect(isStaleRunning({ status: 'done', updatedAt: at(10 * STALE_RUNNING_MS) }, now)).toBe(false);
    expect(isStaleRunning({ status: 'failed', updatedAt: at(10 * STALE_RUNNING_MS) }, now)).toBe(false);
  });
  it('does not guess from an unparseable timestamp', () => {
    expect(isStaleRunning({ status: 'running', updatedAt: 'not-a-date' }, now)).toBe(false);
  });
});

describe('phm runs labels orphaned runs', () => {
  it('shows a killed run as stale and explains the label, leaving live runs as running', async () => {
    runs.push(run('run-orphan', 'running', 2 * 60 * 60 * 1000), run('run-live', 'running', 60 * 1000), run('run-done', 'done', 5 * 60 * 60 * 1000));
    const out = captureLog();
    expect(await cmdRuns([])).toBe(0);
    const text = out.text();
    expect(text).toMatch(/run-orphan\s+stale/);
    expect(text).toMatch(/run-live\s+running/);
    expect(text).toMatch(/run-done\s+done/);
    expect(text).toContain('stale = running with no update for 30+ min');
  });

  it('prints no stale legend when nothing is stale', async () => {
    runs.push(run('run-live', 'running', 60 * 1000));
    const out = captureLog();
    await cmdRuns([]);
    expect(out.text()).not.toContain('stale');
  });

  it('keeps --json as the raw records (status stays running)', async () => {
    runs.push(run('run-orphan', 'running', 2 * 60 * 60 * 1000));
    let written = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { written += String(chunk); return true; });
    await cmdRuns(['--json']);
    expect(JSON.parse(written)[0].status).toBe('running');
  });

  it('phm run show marks a stale run', async () => {
    runs.push(run('run-orphan', 'running', 2 * 60 * 60 * 1000));
    const out = captureLog();
    await cmdRun(['show', 'run-orphan']);
    expect(out.text()).toMatch(/stale: last update 2h ago, likely orphaned/);
  });
});
