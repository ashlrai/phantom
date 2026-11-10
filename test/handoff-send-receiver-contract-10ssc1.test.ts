import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetHandoffReceive } from '../src/cli/fleet-handoff-receive.js';
import { cmdFleetHandoffSend } from '../src/cli/fleet-handoff-send.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { HANDOFF_RECEIVE_BEGIN, HANDOFF_RECEIVE_END } from '../src/core/fleet/handoff-bus-receive.js';
import { isFleetJobId } from '../src/core/fleet/runs-job-detail.js';
import { validateHandoff, type WorkerHandoff } from '../src/core/verse/handoff.js';

let dir: string, root: string, file: string, snapshot: string, output: string[];
const handoff: WorkerHandoff = { id: 'WORK-CONTRACT-1', task: 'Synthetic boundary task',
  files: [{ path: 'src/example.ts' }], constraints: [], check: 'Verify synthetic result' };
const send = (...flags: string[]) => cmdFleetHandoffSend(
  ['--file', file, '--id', 'message-1', '--from', 'planner', '--to', 'worker', ...flags], { root });
const report = () => JSON.parse(output.at(-1)!) as Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'handoff-contract-'));
  root = join(dir, 'bus'); file = join(dir, 'handoff.json'); snapshot = join(dir, 'snapshot.json'); output = [];
  writeFileSync(file, JSON.stringify(handoff));
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: handoff.id, upstreamJobIds: [] },
    tasks: [{ jobId: handoff.id, text: 'Synthetic context' }], outputs: [], byteBudget: 8192 }));
  vi.stubEnv('HOME', dir);
  vi.stubEnv('ASHLR_RUNS_DIR', join(dir, 'runs'));
  vi.stubEnv('ASHLR_HOME', join(dir, 'ashlr'));
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

it('rejects an otherwise valid handoff with an incompatible task id before preview or receipt', async () => {
  const incompatible = { ...handoff, id: 'not a job' };
  expect(validateHandoff(incompatible)).toEqual([]);
  expect(isFleetJobId(incompatible.id)).toBe(false);
  writeFileSync(file, JSON.stringify(incompatible));
  for (const flags of [['--json'], ['--apply', '--json']]) {
    expect(await send(...flags)).toBe(1);
    expect(report()).toEqual({ v: 1, valid: false, problems: [{ field: 'id', detail: 'must be a valid fleet job id' }] });
    expect(output.at(-1)).not.toContain(incompatible.id);
    expect(existsSync(root)).toBe(false);
  }
});

it('delivers a valid handoff once with stable send dedupe to an explicit receiver child', async () => {
  expect(isFleetJobId(handoff.id)).toBe(true);
  expect(await send('--apply', '--json')).toBe(0);
  expect(report()).toMatchObject({ status: 'posted', cursor: 1 });
  expect(await send('--apply', '--json')).toBe(0);
  expect(report()).toMatchObject({ status: 'duplicate', cursor: 1 });
  const page = listBusInboxAfter(0, 50, { root });
  expect(page.status === 'ok' && page.messages.length).toBe(1);
  const runs = join(dir, 'child-runs');
  const capture = join(dir, 'child-input');
  const script = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(runs)},'x');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(capture)},s));`;
  let stderr = '';
  const stdout = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const err = new Writable({ write(chunk, _encoding, done) { stderr += String(chunk); done(); } });
  expect(await cmdFleetHandoffReceive(['--id', 'message-1', '--to', 'worker', '--snapshot', snapshot,
    '--', process.execPath, '-e', script], { root }, { stdout, stderr: err })).toBe(0);
  expect(stderr).toBe('');
  expect(readFileSync(runs, 'utf8')).toBe('x');
  const input = readFileSync(capture, 'utf8');
  expect(input.startsWith(HANDOFF_RECEIVE_BEGIN)).toBe(true);
  expect(input).toContain('Synthetic boundary task');
  expect(input).toContain(HANDOFF_RECEIVE_END);
  expect(input).toContain('Synthetic context');
}, 30000);
