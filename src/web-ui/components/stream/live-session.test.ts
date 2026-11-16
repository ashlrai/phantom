import { describe, expect, it } from 'vitest';
import type { RunState } from '../../data/api-types.js';
import { buildLiveSession, buildLiveSessions, formatElapsedMs, formatQuietLabel } from './live-session.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');

function run(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'r1',
    goal: 'ship the thing',
    engine: 'codex',
    provider: 'openai',
    createdAt: '2026-11-10T11:45:00Z',
    updatedAt: '2026-11-10T11:59:00Z',
    budget: { maxTokens: 100000, maxSteps: 50, allowCloud: true },
    usage: { tokensIn: 12000, tokensOut: 3000, steps: 4, estCostUsd: 0.42 },
    tasks: [],
    steps: [],
    status: 'running',
    ...overrides,
  };
}

describe('buildLiveSession', () => {
  it('derives badge, elapsed, quiet and usage straight off the run', () => {
    const session = buildLiveSession(run({ engineModel: 'codex:gpt-5.5' }), NOW);
    expect(session.engine).toBe('codex');
    expect(session.engineModel).toBe('codex:gpt-5.5');
    expect(session.elapsedMs).toBe(15 * 60_000);
    expect(session.quietMs).toBe(60_000);
    expect(session.tokensIn + session.tokensOut).toBe(15000);
    expect(session.estCostUsd).toBe(0.42);
  });

  it('uses the in-flight task goal as the phase', () => {
    const session = buildLiveSession(
      run({ tasks: [
        { id: 't1', goal: 'scaffold', deps: [], status: 'done' },
        { id: 't2', goal: 'fix the failing tests', deps: ['t1'], status: 'running' },
      ] }),
      NOW,
    );
    expect(session.phase).toBe('fix the failing tests');
    expect(session.tasksDone).toBe(1);
    expect(session.tasksTotal).toBe(2);
  });

  it('reports parallel work honestly when several tasks are running', () => {
    const session = buildLiveSession(
      run({ tasks: [
        { id: 't1', goal: 'a', deps: [], status: 'running' },
        { id: 't2', goal: 'b', deps: [], status: 'running' },
      ] }),
      NOW,
    );
    expect(session.phase).toBe('2 tasks in flight');
  });

  it('falls back to the last step kind when no task is running', () => {
    const session = buildLiveSession(
      run({ steps: [{ ts: '2026-11-10T11:59:00Z', taskId: 't1', kind: 'tool', summary: 'ran tests' }] }),
      NOW,
    );
    expect(session.phase).toBe('Tool step');
    expect(session.lastEvent?.kindLabel).toBe('Tool');
    expect(session.lastEvent?.summary).toBe('ran tests');
  });

  it('says Starting up when nothing has been recorded yet', () => {
    const session = buildLiveSession(run(), NOW);
    expect(session.phase).toBe('Starting up');
    expect(session.lastEvent).toBeNull();
  });

  it('never invents a model — provider is shown when engineModel is absent', () => {
    expect(buildLiveSession(run(), NOW).engineModel).toBeNull();
  });
});

describe('buildLiveSessions', () => {
  it('keeps only running runs, newest-started first, capped', () => {
    const sessions = buildLiveSessions(
      [
        run({ id: 'done', status: 'done', createdAt: '2026-11-10T11:58:00Z' }),
        run({ id: 'older', createdAt: '2026-11-10T10:00:00Z' }),
        run({ id: 'newer', createdAt: '2026-11-10T11:50:00Z' }),
      ],
      NOW,
    );
    expect(sessions.map((s) => s.id)).toEqual(['newer', 'older']);
    expect(buildLiveSessions(undefined, NOW)).toEqual([]);
  });
});

describe('formatters', () => {
  it('formatElapsedMs renders compact clocks', () => {
    expect(formatElapsedMs(42_000)).toBe('42s');
    expect(formatElapsedMs(192_000)).toBe('3m 12s');
    expect(formatElapsedMs(3_840_000)).toBe('1h 4m');
    expect(formatElapsedMs(183_600_000)).toBe('2d 3h');
  });

  it('formatQuietLabel stays silent below the threshold', () => {
    expect(formatQuietLabel(59_000, 60_000)).toBeNull();
    expect(formatQuietLabel(60_000, 60_000)).toBe('quiet 1m 0s');
  });
});
