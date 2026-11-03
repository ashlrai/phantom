import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetAppWatch } from '../src/cli/fleet-app-watch.js';
import type { AppsEnsureChildRunner } from '../src/cli/fleet-apps-ensure.js';

const summary = () => JSON.parse(output.trim());
const events = () => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const success = (outcome = 'running', app = 'Cursor') => ({ code: 0, stdout: JSON.stringify({ app, outcome, running: true }) });
const hung = () => new Promise<ReturnType<AppsEnsureChildRunner>>(() => {});

let output = '';
let consoleLog = '';
let tmpDir = '';

beforeEach(() => {
  output = '';
  consoleLog = '';
  tmpDir = mkdtempSync(join(tmpdir(), 'fw-stop-'));
  vi.useFakeTimers();
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(((text: string) => { consoleLog += text; return true; }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  tmpDir = '';
});

function stopPath(name = 'stop') { return join(tmpDir, name); }
function writeStop(path, value) { writeFileSync(path, value ?? ''); }

describe('stop-file: absent completes normally', () => {
  it('no file present runs normally', async () => {
    const runner = vi.fn<AppsEnsureChildRunner>().mockResolvedValue(success());
    const pending = cmdFleetAppWatch(['Cursor', '--duration-ms', '100', '--json', '--stop-file', stopPath('absent')], { runChild: runner });
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(result).toBe(0);
    expect(summary()).toMatchObject({ outcome: 'completed', checks: 1, recoveries: 0 });
  });
});

describe('stop-file: pre-existing stops zero children', () => {
  it('pre-existing stop file starts zero children', async () => {
    writeStop(stopPath());
    const runner = vi.fn<AppsEnsureChildRunner>();
    const result = await cmdFleetAppWatch(['Cursor', '--duration-ms', '500', '--json', '--stop-file', stopPath()]);
    expect(result).toBe(1);
    expect(summary()).toMatchObject({ outcome: 'cancelled', checks: 0, recoveries: 0 });
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('stop-file: aborts hung child', () => {
  it('creates during hung child aborts signal and returns promptly', async () => {
    const runner = vi.fn<AppsEnsureChildRunner>().mockImplementation(hung);
    const stopFile = stopPath('during-child');
    const pending = cmdFleetAppWatch(['Cursor', '--duration-ms', '5000', '--json', '--stop-file', stopFile], { runChild: runner });
    await Promise.resolve();
    writeStop(stopFile);
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(result).toBe(1);
    expect(summary()).toMatchObject({ outcome: 'cancelled', checks: 1 });
  });
});

describe('stop-file: prevents further children', () => {
  it('during interval sleep prevents another child', async () => {
    let clock = 0;
    let finishSleep!: () => void;
    const runner = vi.fn<AppsEnsureChildRunner>().mockResolvedValue(success());
    const sleep = vi.fn(() => new Promise<void>(resolve => { finishSleep = resolve; }));
    const stopFile = stopPath('during-sleep');
    const pending = cmdFleetAppWatch(['Cursor', '--duration-ms', '5000', '--interval-ms', '100', '--json', '--stop-file', stopFile], { runChild: runner, sleep, now: () => clock });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1), { timeout: 1000 });
    writeStop(stopFile);
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(result).toBe(1);
    expect(summary()).toMatchObject({ outcome: 'cancelled', checks: 1 });
  });
});

describe('stop-file: filesystem errors', () => {
  it('probe error fails closed with exit 1', async () => {
    const runner = vi.fn<AppsEnsureChildRunner>().mockResolvedValue(success());
    const stopFile = stopPath('probe-error');
    const result = await cmdFleetAppWatch(['Cursor', '--duration-ms', '500', '--stop-file', stopFile], {
      runChild: runner,
      stopFileExists: () => { throw new Error('permission denied'); },
    });
    expect(result).toBe(1);
    expect(consoleLog).toContain('failed');
  });
});

describe('stop-file: late child settlement', () => {
  it('produces no output after exactly one terminal summary', async () => {
    let finish!: (r: ReturnType<AppsEnsureChildRunner>) => void;
    const runner = vi.fn<AppsEnsureChildRunner>(() => new Promise(resolve => { finish = resolve; }));
    const stopFile = stopPath('late-child');
    const pending = cmdFleetAppWatch(['Cursor', '--duration-ms', '5000', '--jsonl', '--stop-file', stopFile], { runChild: runner });
    await Promise.resolve();
    writeStop(stopFile);
    await vi.advanceTimersByTimeAsync(200);
    const before = output;
    finish(success('launched'));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(result).toBe(1);
    const evts = events();
    expect(evts.length).toBe(1);
    expect(evts[0]).toMatchObject({ type: 'summary', outcome: 'cancelled' });
  });
});

describe('stop-file: JSONL mode', () => {
  it('emits cancelled summary with JSONL', async () => {
    writeStop(stopPath('jsonl'));
    const runner = vi.fn<AppsEnsureChildRunner>();
    const result = await cmdFleetAppWatch(['Cursor', '--duration-ms', '1000', '--jsonl', '--stop-file', stopPath('jsonl')]);
    expect(result).toBe(1);
    const evts = events();
    expect(evts.length).toBeGreaterThanOrEqual(1);
    expect(evts[evts.length - 1]).toMatchObject({ type: 'summary', outcome: 'cancelled' });
  });
});

describe('stop-file: argument validation', () => {
  it.each([
    ['missing path', ['Cursor', '--duration-ms', '100', '--stop-file']],
    ['duplicated flag', ['Cursor', '--duration-ms', '100', '--stop-file', '/tmp/s', '--stop-file', '/tmp/x']],
  ])('rejects %s with exit 2', async (label, argPart: string[]) => {
    const runner = vi.fn<AppsEnsureChildRunner>();
    const result = await cmdFleetAppWatch(['Cursor', '--duration-ms', '100', ...argPart], { runChild: runner });
    expect(result).toBe(2);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('stop-file: relative path resolution', () => {
  it('resolves relative stop-file path against cwd', async () => {
    const savedCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      writeStop('rel-stop');
      const runner = vi.fn<AppsEnsureChildRunner>();
      const result = await cmdFleetAppWatch(['Cursor', '--duration-ms', '500', '--json', '--stop-file', 'rel-stop'], { runChild: runner });
      expect(result).toBe(1);
      expect(runner).not.toHaveBeenCalled();
    } finally { process.chdir(savedCwd); }
  });
});

describe('stop-file: does not delete stop file', () => {
  it('preserves existing stop file on cancellation', async () => {
    const file = stopPath('preserve');
    writeStop(file, 'persistent');
    const runner = vi.fn<AppsEnsureChildRunner>();
    const result = await cmdFleetAppWatch(['Cursor', '--duration-ms', '500', '--json', '--stop-file', file], { runChild: runner });
    expect(result).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('persistent');
  });
});
