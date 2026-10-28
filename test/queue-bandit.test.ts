import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdQueue } from '../src/cli/queue.js';

const fixture = new URL('./fixtures/bandit/outcomes.jsonl', import.meta.url).pathname;

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { out.push(String(line ?? '')); });
  vi.spyOn(console, 'error').mockImplementation((line?: unknown) => { err.push(String(line ?? '')); });
  return { out, err };
}

describe('phm queue bandit', () => {
  it('prints the before/after reward table in human form', async () => {
    const { out, err } = capture();
    const code = await cmdQueue(['bandit', '--events', fixture, '--seed', '7']);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const text = out.join('\n');
    expect(text).toContain('Lane reward replay (rejection-sampling, seed 7)');
    expect(text).toContain('records: 95');
    expect(text).toContain('static (before)');
    expect(text).toContain('bandit (after)');
    expect(text).toContain('delta: +');
  });

  it('emits the machine report with --json', async () => {
    const { out } = capture();
    const code = await cmdQueue(['bandit', '--events', fixture, '--seed', '7', '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(out.join('\n'));
    expect(report.schema).toBe('phantom-router-bandit-replay/v1');
    expect(report.records).toBe(95);
    expect(report.after.meanReward).toBeGreaterThan(report.before.meanReward);
    expect(report.delta.meanReward).toBeGreaterThan(0);
  });

  it('returns 2 on usage errors and 1 on unreadable or malformed inputs', async () => {
    const { err } = capture();
    expect(await cmdQueue(['bandit'])).toBe(2);
    expect(await cmdQueue(['bandit', '--events'])).toBe(2);
    expect(await cmdQueue(['bandit', '--events', '/nonexistent/file.jsonl'])).toBe(1);
    expect(await cmdQueue(['bandit', '--events', fixture, '--seed', 'abc'])).toBe(2);
    expect(err.join('\n')).toContain('--seed must be an integer');
  });

  it('honors a router-bandit.json --config for credit floor and weights', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bandit-cfg-'));
    dirs.push(dir);
    const configPath = join(dir, 'router-bandit.json');
    writeFileSync(configPath, JSON.stringify({ creditFloor: 0, reward: { cost: 0.5, wall: 0.5 } }));
    const { out, err } = capture();
    const code = await cmdQueue(['bandit', '--events', fixture, '--config', configPath, '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(out.join('\n'));
    expect(report.config.reward.cost).toBe(0.5);
    expect(report.config.reward.wall).toBe(0.5);
    expect(err).toEqual([]);

    writeFileSync(configPath, '{bad');
    expect(await cmdQueue(['bandit', '--events', fixture, '--config', configPath])).toBe(1);
  });

  it('keeps phm queue report working unchanged', async () => {
    const { out } = capture();
    const dir = mkdtempSync(join(tmpdir(), 'queue-events-'));
    dirs.push(dir);
    const events = join(dir, 'events.jsonl');
    writeFileSync(events, '{"station":"ci","arrivedAt":"2026-10-20T00:00:00Z","startedAt":"2026-10-20T00:10:00Z","completedAt":"2026-10-20T01:00:00Z"}\n');
    expect(await cmdQueue(['report', '--events', events, '--json'])).toBe(0);
    const report = JSON.parse(out.join('\n'));
    expect(report.stations[0].station).toBe('ci');
    expect(await cmdQueue(['nope'])).toBe(2);
    expect(await cmdQueue(['--help'])).toBe(0);
  });
});
