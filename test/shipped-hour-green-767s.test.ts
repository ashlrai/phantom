import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cmdShipped } from '../src/cli/shipped.js';
import { composeBrief } from '../src/core/comms/leader-brief.js';
import { readHourShipped } from '../src/core/fleet/shipped-hour.js';

it('uses origin history for both command formats and composes the optional line once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hour-green-'));
  try {
    const repo = join(root, 'fixture'); mkdirSync(repo);
    const now = Date.parse('2026-11-20T12:00:00Z');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-20T11:55:00Z', GIT_COMMITTER_DATE: '2026-11-20T11:55:00Z' } });
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(repo, 'file'), 'one'); git('add', '.'); git('commit', '-qm', 'Fix lane (#1)');
    const run = async (json: boolean) => {
      const output: string[] = [];
      const code = await cmdShipped(['--since', '1h', ...(json ? ['--json'] : [])], { now: () => now, out: line => output.push(line), hour: () => readHourShipped({ now, roots: [root] }) });
      return { code, output: output[0]! };
    };
    expect((await run(true)).code).toBe(1);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const text = await run(false); const json = await run(true);
    const report = JSON.parse(json.output);
    expect([text.code, json.code]).toEqual([0, 0]);
    expect(text.output.split('\n')[0]).toBe(report.headline);
    expect(report.items.map((item: { number: number }) => item.number)).toEqual([1]);
    const facts = { nowMs: now, sinceMs: now - 3_600_000, shipped: [], prsOpened: 0, running: [], blockers: [], next: [], question: null, pendingActionIds: [] };
    const baseline = composeBrief('instant', facts);
    const lines = composeBrief('instant', { ...facts, hourLine: report.headline }).split('\n');
    expect(lines[1]).toBe(report.headline);
    expect(lines.filter(line => line === report.headline)).toHaveLength(1);
    expect(composeBrief('instant', { ...facts, hourLine: null })).toBe(baseline);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
