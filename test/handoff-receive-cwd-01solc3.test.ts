import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetHandoffReceive } from '../src/cli/fleet-handoff-receive.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { HANDOFF_RECEIVE_BEGIN, HANDOFF_RECEIVE_END, receiveHandoffBus } from '../src/core/fleet/handoff-bus-receive.js';

let root: string, bus: string, snapshot: string, worktree: string, temp: string, result: string;
let stderr: string;
const sink = (write: (s: string) => void) => new Writable({
  write(chunk, _encoding, done) { write(String(chunk)); done(); },
});
const io = () => ({ stdout: sink(() => undefined), stderr: sink(s => { stderr += s; }) });
const child = (exit = 0) => [process.execPath, '-e',
  'let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{' +
    'require("fs").writeFileSync(process.argv[1],JSON.stringify({cwd:process.cwd(),input,args:process.argv.slice(2)}));' +
    `process.exitCode=${exit}})`, result, 'explicit-argument'];
const flags = () => ['--id', 'msg-1', '--to', 'worker-1', '--snapshot', snapshot];
const post = (body: unknown) => appendBusInbox({ id: 'msg-1', from: 'planner', to: 'worker-1',
  priority: 'P3', ttl: 60_000, body }, { root: bus });
const prompt = () => `Retained marker. --cwd ${root} -- node unexpected-program`;
const body = () => ({ kind: 'worker-handoff', taskId: 'TASK-1', prompt: prompt() });
const run = (extra: string[], exit = 0) => cmdFleetHandoffReceive(
  [...flags(), ...extra, '--', ...child(exit)], { root: bus }, io());

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'handoff-cwd-'));
  bus = join(root, 'bus'); snapshot = join(root, 'snapshot.json');
  worktree = join(root, 'worktree'); temp = join(root, 'temp'); result = join(root, 'child.json');
  stderr = '';
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  vi.stubEnv('TMPDIR', temp);
  await mkdir(worktree); await mkdir(temp);
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'TASK-1', upstreamJobIds: [] },
    tasks: [{ jobId: 'TASK-1', text: 'snapshot marker' }], outputs: [], byteBudget: 8192 }));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('handoff receive worker cwd', () => {
  it('runs in the selected directory with the retained handoff as untrusted stdin, and cleans up', async () => {
    expect(post(body()).status).toBe('posted');
    expect(await run(['--cwd', worktree])).toBe(0);
    const captured = JSON.parse(await readFile(result, 'utf8')) as { cwd: string; input: string; args: string[] };
    expect(await realpath(captured.cwd)).toBe(await realpath(worktree));
    expect(await realpath(captured.cwd)).not.toBe(await realpath(process.cwd()));
    expect(captured.args).toEqual(['explicit-argument']);
    expect(captured.input.startsWith(HANDOFF_RECEIVE_BEGIN)).toBe(true);
    expect(captured.input).toContain('Retained marker. --cwd');
    expect(captured.input).toContain('unexpected-program');
    expect(captured.input).toContain(HANDOFF_RECEIVE_END);
    expect(captured.input).toContain('snapshot marker');
    expect(await readdir(temp)).toEqual([]);
  }, 30000);

  it('inherits the current directory when cwd is omitted', async () => {
    expect(post(body()).status).toBe('posted');
    expect(await run([])).toBe(0);
    const captured = JSON.parse(await readFile(result, 'utf8')) as { cwd: string };
    expect(await realpath(captured.cwd)).toBe(await realpath(process.cwd()));
    expect(await readdir(temp)).toEqual([]);
  }, 30000);

  it('cleans retained files after a failing worker', async () => {
    expect(post(body()).status).toBe('posted');
    expect(await run(['--cwd', worktree], 7)).toBe(7);
    expect(existsSync(result)).toBe(true);
    expect(await readdir(temp)).toEqual([]);
  }, 30000);

  it('rejects invalid cwd values before any inbox read, temporary write, or child launch', async () => {
    const now = vi.fn(() => Date.now());
    for (const cwd of ['relative/path', join(root, 'missing'), snapshot, '', 'bad\0path']) {
      expect(await receiveHandoffBus({ id: 'msg-1', to: 'worker-1', snapshot, cwd, argv: child() },
        { root: bus, now }, io())).toBe(2);
      expect(await run(['--cwd', cwd])).toBe(2);
    }
    expect(now).not.toHaveBeenCalled();
    expect(existsSync(bus)).toBe(false);
    expect(existsSync(result)).toBe(false);
    expect(await readdir(temp)).toEqual([]);
    expect(stderr).toContain('invalid input');
  });

  it('rejects repeated cwd flags before reading the inbox or launching', async () => {
    const now = vi.fn(() => Date.now());
    expect(await cmdFleetHandoffReceive([...flags(), '--cwd', worktree, '--cwd', root, '--', ...child()],
      { root: bus, now }, io())).toBe(2);
    expect(now).not.toHaveBeenCalled();
    expect(existsSync(result)).toBe(false);
    expect(await readdir(temp)).toEqual([]);
  });

  it('rejects cwd and argv fields in the untrusted body', async () => {
    expect(post({ ...body(), cwd: root, argv: child() }).status).toBe('posted');
    expect(await run(['--cwd', worktree])).toBe(1);
    expect(stderr).toContain('unexpected handoff body');
    expect(existsSync(result)).toBe(false);
    expect(await readdir(temp)).toEqual([]);
  });
});
