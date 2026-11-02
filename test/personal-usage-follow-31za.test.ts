/* global AbortController */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runPersonalUsageFollow } from '../examples/agents/personal-usage-follow.js';
import type { CodexSessionUsage } from '../src/core/fleet/codex-session-usage.js';

const start = Date.parse('2036-06-14T12:00:00Z');
const reset = Date.parse('2036-06-21T12:00:00Z') / 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const usage = (at: number | null, pct: number, resetsAt: number | null = reset): CodexSessionUsage => ({
  accountId: 'fake', slot: 'primary', observedAt: at === null ? null : iso(at),
  planType: 'pro', limitId: 'fake', limitName: 'fake label', rateLimitReachedType: null,
  spendControlReached: null, individualLimit: null, model: 'fake-model', originator: 'fake-cli', cliVersion: '1',
  primary: null, secondary: { usedPercent: pct, windowMinutes: 10080, resetsAt }, credits: null,
});

async function observe(readings: CodexSessionUsage[][], args: string[] = []) {
  const lines: string[] = [];
  const errors: string[] = [];
  let index = 0;
  const read = vi.fn(() => readings[Math.min(index, readings.length - 1)]!);
  const result = await runPersonalUsageFollow(args, {
    homeDir: '/fake-home', now: () => start + index * 5000, read,
    wait: async () => { index++; }, stdout: line => { lines.push(line); }, stderr: line => { errors.push(line); },
  });
  return { result, lines: lines.map(line => JSON.parse(line)), errors: errors.map(line => JSON.parse(line)), read };
}

describe('personal usage follow', () => {
  it('uses only the personal home and compares advancing evidence', async () => {
    const run = await observe([[usage(start, 40)], [usage(start + 5000, 43)]]);
    expect(run.result).toBe(0);
    expect(run.read).toHaveBeenCalledTimes(2);
    expect(run.read).toHaveBeenCalledWith({
      env: { CODEX_HOME: '/fake-home/.codex-2', CODEX_HOME_ALT: '/fake-home/.codex-2' }, homeDir: '/fake-home',
    });
    expect(run.lines).toHaveLength(3);
    expect(run.lines[0]).toMatchObject({ type: 'sample', sampledAt: iso(start), resource: {
      id: 'codex-personal', slot: 'secondary', model: null, limitId: null,
      weekly: { usedPct: 40, burnPctPerHour: null },
    } });
    expect(run.lines[2]).toEqual({ type: 'summary', status: 'completed', samples: 2,
      first: { observedAt: iso(start), usedPct: 40 }, last: { observedAt: iso(start + 5000), usedPct: 43 },
      weeklyUsedPctDelta: 3 });
    expect(run.errors).toEqual([]);
  });

  it('distinguishes repeated evidence from a new reading with zero change', async () => {
    expect((await observe([[usage(start, 40)], [usage(start, 40)]])).lines[2].weeklyUsedPctDelta).toBeNull();
    expect((await observe([[usage(start, 40)], [usage(start + 5000, 40)]])).lines[2].weeklyUsedPctDelta).toBe(0);
  });

  it('reports unknown for stale, missing, future, reset or inconsistent evidence', async () => {
    const cases: CodexSessionUsage[][][] = [
      [[usage(start - 2 * 86400000, 40)], [usage(start + 5000, 45)]],
      [[], [usage(start + 5000, 45)]],
      [[usage(null, 40)], [usage(start + 5000, 45)]],
      [[usage(start, 40, null)], [usage(start + 5000, 45, null)]],
      [[usage(start, 40)], [usage(start + 5000, 2, reset + 604800)]],
      [[usage(start, 40)], [usage(start + 5000, 2)]],
      [[usage(start + 1000, 40)], [usage(start + 5000, 45)]],
      [[usage(start, 40)], [usage(start, 45)]],
      [[{ ...usage(start, 40), secondary: null }], [usage(start + 5000, 45)]],
    ];
    for (const readings of cases) {
      expect((await observe(readings)).lines[2].weeklyUsedPctDelta).toBeNull();
    }
  });

  it('does not hide an intermediate reset when the final percentage recovers', async () => {
    const run = await observe([[usage(start, 40)], [usage(start + 5000, 2)], [usage(start + 10000, 50)]], ['--samples', '3']);
    expect(run.lines[3].weeklyUsedPctDelta).toBeNull();
  });

  it('honors bounded options and rejects malformed or duplicated arguments', async () => {
    const valid = await observe([[usage(start, 40)]], ['--samples', '3', '--interval-ms', '1000']);
    expect(valid.lines).toHaveLength(4);
    for (const args of [['--samples', '1'], ['--samples', '61'], ['--interval-ms', '999'],
      ['--interval-ms', '60001'], ['--samples', '2.0'], ['--samples'], ['--home', '/fake'],
      ['--samples', '2', '--samples', '2'], ['toString', '5000']]) {
      const run = await observe([[usage(start, 40)]], args);
      expect(run.result).toBe(2);
      expect(run.read).not.toHaveBeenCalled();
      expect(run.errors).toEqual([{ type: 'error', code: 'invalid_arguments' }]);
    }
  });

  it('returns a final unknown summary when cancelled during a wait', async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const read = vi.fn(() => [usage(start, 40)]);
    const result = await runPersonalUsageFollow([], {
      homeDir: '/fake-home', now: () => start, read, signal: controller.signal,
      wait: async () => { controller.abort(); throw new Error('fake abort detail'); },
      stdout: line => { lines.push(line); },
    });
    expect(result).toBe(130);
    expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: 'summary', status: 'cancelled', samples: 1, weeklyUsedPctDelta: null });
  });

  it('emits a stable error without exception text', async () => {
    const errors: string[] = [];
    const result = await runPersonalUsageFollow([], {
      homeDir: '/fake-home', read: () => { throw new Error('private fake detail'); },
      stderr: line => { errors.push(line); },
    });
    expect(result).toBe(1);
    expect(errors).toEqual(['{"type":"error","code":"observation_failed"}\n']);
  });

  it('reads a fake personal rollout through the actual collector and observes an update', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fake-personal-follow-'));
    try {
      const day = join(home, '.codex-2', 'sessions', '2036', '06', '14');
      mkdirSync(day, { recursive: true });
      const file = join(day, 'rollout-fake.jsonl');
      const write = (at: number, pct: number) => writeFileSync(file, `${JSON.stringify({
        timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', rate_limits: {
          secondary: { used_percent: pct, window_minutes: 10080, resets_at: reset },
        } },
      })}\n`);
      write(start, 12);
      let now = start;
      const lines: string[] = [];
      const result = await runPersonalUsageFollow([], { homeDir: home, now: () => now,
        wait: async () => { now += 5000; write(now, 15); }, stdout: line => { lines.push(line); } });
      expect(result).toBe(0);
      expect(JSON.parse(lines[2]!).weeklyUsedPctDelta).toBe(3);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('refuses a redirected sessions tree before invoking the collector', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fake-personal-link-'));
    try {
      mkdirSync(join(home, '.codex-2'));
      mkdirSync(join(home, 'other'));
      symlinkSync(join(home, 'other'), join(home, '.codex-2', 'sessions'));
      const errors: string[] = [];
      const result = await runPersonalUsageFollow([], { homeDir: home, now: () => start,
        stderr: line => { errors.push(line); } });
      expect(result).toBe(1);
      expect(errors).toEqual(['{"type":"error","code":"observation_failed"}\n']);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
