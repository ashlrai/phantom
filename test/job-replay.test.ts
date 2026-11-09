import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJobTimeline, MAX_REPLAY_BYTES, parseJobTimeline } from '../src/core/run/job-replay.js';
import { renderReplay, runReplay } from '../src/tui/replay.js';
import { cmdReplay } from '../src/cli/replay.js';

const fixture = readFileSync(new URL('./fixtures/job-replay/steps.jsonl', import.meta.url), 'utf8');
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function store(text = fixture): string {
  const root = mkdtempSync(join(tmpdir(), 'job-replay-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  mkdirSync(join(root, '.ashlr', 'run-streams'), { recursive: true, mode: 0o700 });
  const path = join(root, '.ashlr', 'run-streams', 'job-1.log');
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}
function record(text: string, kind = 'model-delta'): string {
  return JSON.stringify({ ts: '2026-10-28T10:00:00Z', kind, text }) + '\n';
}

describe('job replay', () => {
  it('renders the stored fixture in log order with tool calls, edits and checks', () => {
    const path = store();
    const timeline = loadJobTimeline('job-1');
    expect(timeline.steps.map(step => step.kind)).toEqual(['task-start', 'tool-call', 'edit', 'check', 'task-done']);
    const output = renderReplay(timeline, 0, 120, 24);
    expect(output).toContain('[edit] tool: Edit src/example.ts');
    expect(output).toContain('[check] npm run typecheck: passed');
    expect(readFileSync(path, 'utf8')).toBe(fixture);
  });
  it('pages a timeline without exposing future rows in the current frame', () => {
    const output = renderReplay(parseJobTimeline(fixture), 1, 120, 6);
    expect(output).toContain('2.');
    expect(output).toContain('3.');
    expect(output).not.toContain('Completed');
    expect(output).toContain('Steps 2-3 / 5');
  });
  it('strips ordinary line controls without suppressing safe payloads', () => {
    expect(renderReplay(parseJobTimeline(record('First line\nSecond line')))).toContain('First lineSecond line');
  });
  it('omits and labels a partial final record', () => {
    const timeline = parseJobTimeline(fixture + '{"text":"unfinished');
    expect(timeline.steps).toHaveLength(5);
    expect(renderReplay(timeline)).toContain('incomplete final record omitted');
  });
  it.each(['{bad}\n', '{}\n', record('bad', 'unknown'), '{"ts":"bad","kind":"log","text":"x"}\n'])('refuses corrupt records without echoing input', text => {
    expect(() => parseJobTimeline(text)).toThrow('Invalid replay log.');
  });
  it('enforces bounded input', () => {
    expect(() => parseJobTimeline('x'.repeat(MAX_REPLAY_BYTES + 1))).toThrow('size limit');
  });
  it.each(['../elsewhere', '/tmp/file', '..', '', '-option'])('refuses unsafe job IDs: %s', id => {
    expect(() => loadJobTimeline(id)).toThrow('Invalid job ID');
  });
  it('refuses missing and symlink logs', () => {
    const path = store();
    expect(() => loadJobTimeline('absent')).toThrow('unavailable');
    symlinkSync(path, join(path, '..', 'link.log'));
    expect(() => loadJobTimeline('link')).toThrow('unavailable');
  });
  it('redacts credentials split across records and terminal escape sequences', () => {
    const secret = 'ghp_' + 'A1b2C3d4'.repeat(5);
    const split = record(secret.slice(0, 8)) + record(secret.slice(8));
    const output = renderReplay(parseJobTimeline(split));
    expect(output).not.toContain(secret.slice(8));
    expect(output).toContain('redacted');
    const escaped = record(secret.slice(0, 8) + '\x1b[31m' + secret.slice(8));
    expect(renderReplay(parseJobTimeline(escaped))).not.toContain(secret.slice(8));
  });
  it('does not render terminal controls or secret values in any text payload', () => {
    const output = renderReplay(parseJobTimeline(record('PASSWORD=fixture-only-password\x1b[2J\r')));
    expect(output).not.toContain('fixture-only-password');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('\r');
  });
  it('supports once mode through the CLI and the TUI without raw mode', async () => {
    store();
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdReplay(['job-1', '--once'])).toBe(0);
    expect(write.mock.calls.map(call => call[0]).join('')).toContain('Completed');
    write.mockClear();
    expect(await runReplay(parseJobTimeline(''), true)).toBe(0);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('No recorded steps.'));
  });
  it('rejects invalid CLI arguments and gives value-blind errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdReplay([])).toBe(2);
    expect(await cmdReplay(['job-1', '--bad'])).toBe(2);
    expect(await cmdReplay(['../private'])).toBe(1);
    expect(console.error).toHaveBeenLastCalledWith('Replay log unavailable or invalid.');
  });
});

describe('interactive replay terminal', () => {
  it('restores raw mode and listeners on quit', async () => {
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const originalRaw = process.stdin.setRawMode;
    const originalIsRaw = process.stdin.isRaw;
    const beforeSignals = process.listenerCount('SIGINT');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const setRaw = vi.fn();
    process.stdin.setRawMode = setRaw;
    vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    const pause = vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const replay = runReplay(parseJobTimeline(fixture), false);
      process.stdin.emit('keypress', 'j', { name: 'j' });
      process.stdin.emit('keypress', 'q', { name: 'q' });
      expect(await replay).toBe(0);
      expect(setRaw.mock.calls).toEqual([[true], [originalIsRaw]]);
      expect(pause).toHaveBeenCalled();
      expect(process.listenerCount('SIGINT')).toBe(beforeSignals);
      expect(write).toHaveBeenLastCalledWith('\x1b[?25h\x1b[?1049l');
    } finally {
      process.stdin.setRawMode = originalRaw;
      if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });
});
