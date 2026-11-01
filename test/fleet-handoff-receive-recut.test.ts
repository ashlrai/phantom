import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetHandoffReceive } from '../src/cli/fleet-handoff-receive.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';

let root: string;
let snapshot: string;
let marker: string;
let stdout: string;
let stderr: string;
const sink = (write: (s: string) => void) => new Writable({
  write(chunk, _encoding, done) { write(String(chunk)); done(); },
});
const run = (recipient = 'worker-1') => cmdFleetHandoffReceive([
  '--id', 'handoff-1', '--to', recipient, '--snapshot', snapshot, '--',
  process.execPath, '-e',
  'require("fs").writeFileSync(process.argv[1], "started"); let s=""; process.stdin.on("data", c=>s+=c); process.stdin.on("end", ()=>{process.stdout.write(JSON.stringify({s,args:process.argv.slice(2)})); process.stderr.write("worker diagnostic\\n"); process.exitCode=7})',
  marker, '', '$(literal)',
], { root: join(root, 'bus') }, {
  stdout: sink(s => { stdout += s; }), stderr: sink(s => { stderr += s; }),
});
const writeSnapshot = (jobId: string) => writeFile(snapshot, JSON.stringify({
  node: { jobId, upstreamJobIds: [] },
  tasks: [{ jobId, text: 'cited snapshot marker' }], outputs: [], byteBudget: 8192,
}));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'handoff-recut-'));
  snapshot = join(root, 'snapshot.json');
  marker = join(root, 'started');
  stdout = ''; stderr = '';
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  await writeSnapshot('TASK-1');
  expect(appendBusInbox({ id: 'handoff-1', from: 'planner', to: 'worker-1', priority: 'P3',
    ttl: 60_000, body: { kind: 'worker-handoff', taskId: 'TASK-1', prompt: 'cited handoff marker' },
  }, { root: join(root, 'bus') }).status).toBe('posted');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('delivers the live handoff and cited snapshot to a real worker and propagates its status', async () => {
  expect(await run()).toBe(7);
  const output = JSON.parse(stdout) as { s: string; args: string[] };
  expect(output.s).toContain('BEGIN UNTRUSTED RETAINED BUS HANDOFF');
  expect(output.s).toContain('cited handoff marker');
  expect(output.s).toContain('BEGIN UNTRUSTED CITED CONTEXT JSONL');
  expect(output.s).toContain('cited snapshot marker');
  expect(output.args).toEqual(['', '$(literal)']);
  expect(stderr).toBe('worker diagnostic\n');
  expect(existsSync(marker)).toBe(true);
});

it('does not launch for the wrong recipient or a mismatched snapshot', async () => {
  expect(await run('WORKER-1')).toBe(1);
  expect(existsSync(marker)).toBe(false);
  await writeSnapshot('OTHER-1');
  expect(await run()).toBe(1);
  expect(existsSync(marker)).toBe(false);
  expect(stdout).toBe('');
});
