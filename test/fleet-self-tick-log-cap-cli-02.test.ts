/**
 * RQ-PHX-SELFTICKLOGCAP02 — through the real cmdFleetSelfTick against a
 * temp home: a run caps the scheduled self-tick log
 * (<home>/.ashlr/logs/self-tick.jsonl) before its steps and reports
 * logCap.state in --json, while --last is a read-only path that never
 * touches the log. Nothing here resolves the real home or ~/.ashlr.
 */
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import {
  SELF_TICK_LOG_MAX_BYTES, selfTickLogPath,
} from '../src/core/fleet/self-tick-log-cap.js';
import type { SelfTickStep, SelfTickSteps } from '../src/core/fleet/self-tick.js';

const NOW_MS = Date.parse('2026-11-01T12:00:00Z');

let home: string;
let runsDir: string;
let log: string;

const stub = (name: string): SelfTickStep => async () =>
  ({ exitCode: 0, output: JSON.stringify({ ok: name }) });
const steps: SelfTickSteps = {
  'reset-release': stub('reset-release'),
  'lane-autohold': stub('lane-autohold'),
  'planner-tick': stub('planner-tick'),
  'inbox-acks': stub('inbox-acks'),
  'landed-sweep': stub('landed-sweep'),
};

const run = async (args: string[]) => {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetSelfTick(args, {
    now: () => NOW_MS, home, steps,
    output: (text) => out.push(text), error: (text) => err.push(text),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
};

const oversize = (): { size: number; content: string } => {
  const line = `{"step":"planner-tick","report":"${'x'.repeat(120)}"}\n`;
  const count = Math.ceil((SELF_TICK_LOG_MAX_BYTES + 2048) / Buffer.byteLength(line));
  const content = `${line.repeat(count)}{"step":"newest"}\n`;
  writeFileSync(log, content);
  return { size: statSync(log).size, content };
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'self-tick-log-cap-cli-'));
  runsDir = join(home, 'runs');
  log = selfTickLogPath(home);
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('fleet self-tick log cap', () => {
  it('a run caps an oversize log before its steps and reports logCap', async () => {
    const { size: before } = oversize();
    expect(before).toBeGreaterThan(SELF_TICK_LOG_MAX_BYTES);
    const { code, stdout } = await run(['--json', '--runs-dir', runsDir]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as { state: string; logCap?: { state: string } };
    expect(report.state).toBe('ran');
    expect(report.logCap).toEqual({ state: 'capped' });
    const after = statSync(log);
    expect(after.size).toBeLessThan(SELF_TICK_LOG_MAX_BYTES);
    expect(readFileSync(log, 'utf8').endsWith('{"step":"newest"}\n')).toBe(true);
    expect(after.mode & 0o777).toBe(0o600);
  });

  it('an absent log is reported and never created by the cap', async () => {
    const { code, stdout } = await run(['--json', '--runs-dir', runsDir]);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { logCap?: { state: string } }).logCap)
      .toEqual({ state: 'absent' });
    expect(existsSync(log)).toBe(false);
  });

  it('--last leaves the log untouched', async () => {
    const { size: before, content } = oversize();
    const { code } = await run(['--last', '--json', '--runs-dir', runsDir]);
    expect(code).toBe(0);
    expect(statSync(log).size).toBe(before);
    expect(readFileSync(log, 'utf8')).toBe(content);
  });
});
