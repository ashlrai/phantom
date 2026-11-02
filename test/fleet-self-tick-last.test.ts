/**
 * RQ-PHX-SELFTICKLASTRUN02 — queue/self-tick-last.json persistence for
 * `ashlr fleet self-tick`: atomic private write, sanitized step reports
 * capped at 16 KB, and a defensive read that answers null / unreadable /
 * the recorded run's fields.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readSelfTickLast, SELF_TICK_LAST, writeSelfTickLast,
} from '../src/core/fleet/self-tick-last.js';
import type { SelfTickReport, SelfTickStepResult } from '../src/core/fleet/self-tick.js';

const NOW_MS = Date.parse('2026-11-01T12:00:00Z');
const AT = new Date(NOW_MS).toISOString();
const LAST = () => join(runsDir, SELF_TICK_LAST);

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'self-tick-last-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

const step = (name: SelfTickStepResult['step'], state: 'ok' | 'failed', report: unknown): SelfTickStepResult =>
  ({ step: name, state, exitCode: state === 'ok' ? 0 : 1, report });

const report = (overrides: Partial<SelfTickReport> = {}): SelfTickReport => ({
  v: 1,
  at: AT,
  mode: 'apply',
  state: 'ran',
  steps: [
    step('claude-quota', 'ok', { weeklyPct: 42 }),
    step('reset-release', 'ok', { released: ['devin'] }),
    step('lane-autohold', 'failed', { error: 'boom' }),
    step('planner-tick', 'ok', null),
  ],
  ...overrides,
});

describe('self-tick last record', () => {
  it('write then read round-trips at, mode and failedSteps', () => {
    writeSelfTickLast(runsDir, report());
    const view = readSelfTickLast(runsDir, NOW_MS);
    expect(view).toEqual({
      state: 'ok', at: AT, mode: 'apply', ranState: 'ran',
      ageSeconds: 0, failedSteps: ['lane-autohold'],
    });
    const stored = JSON.parse(readFileSync(LAST(), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({ v: 1, at: AT, mode: 'apply', state: 'ran' });
    expect((stored['steps'] as unknown[]).length).toBe(4);
  });

  it('ageSeconds is measured from the injected now', () => {
    writeSelfTickLast(runsDir, report());
    const view = readSelfTickLast(runsDir, NOW_MS + 150_000);
    expect(view).toMatchObject({ state: 'ok', ageSeconds: 150 });
    const early = readSelfTickLast(runsDir, NOW_MS - 10_000);
    expect(early).toMatchObject({ state: 'ok', ageSeconds: 0 });
  });

  it('a missing file reads null', () => {
    expect(readSelfTickLast(runsDir, NOW_MS)).toBeNull();
    expect(existsSync(LAST())).toBe(false);
  });

  it('a corrupt file reads unreadable, never throws', () => {
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(LAST(), 'not json {', 'utf8');
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
    writeFileSync(LAST(), JSON.stringify({ at: AT, mode: 'sideways' }), 'utf8');
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
    writeFileSync(LAST(), JSON.stringify([1, 2, 3]), 'utf8');
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
  });

  it('a step report over 16 KB of JSON is stored as truncated', () => {
    const big = { pad: 'x'.repeat(20 * 1024) };
    writeSelfTickLast(runsDir, report({
      steps: [step('planner-tick', 'ok', big)],
    }));
    const stored = JSON.parse(readFileSync(LAST(), 'utf8')) as {
      steps: { step: string; report: unknown }[];
    };
    expect(stored.steps[0]).toMatchObject({ step: 'planner-tick', report: { truncated: true } });
    // Exactly at the cap still round-trips.
    const atCap = { pad: 'y'.repeat(16 * 1024 - JSON.stringify({ pad: '' }).length) };
    writeSelfTickLast(runsDir, report({ steps: [step('planner-tick', 'ok', atCap)] }));
    const stored2 = JSON.parse(readFileSync(LAST(), 'utf8')) as { steps: { report: unknown }[] };
    expect(stored2.steps[0]!.report).toEqual(atCap);
  });

  it('a home-dir path in a step report is scrubbed on disk', () => {
    const home = homedir();
    writeSelfTickLast(runsDir, report({
      steps: [step('planner-tick', 'ok', { promptPath: join(home, '.ashlr-runs', 'prompt.md') })],
    }));
    const raw = readFileSync(LAST(), 'utf8');
    expect(raw).not.toContain(home);
    expect(raw).toContain('~/.ashlr-runs/prompt.md');
  });

  it('the record file is mode 0o600', () => {
    writeSelfTickLast(runsDir, report());
    expect(statSync(LAST()).mode & 0o777).toBe(0o600);
  });
});
