import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { cmdFleetBusWorkLoop } from '../src/cli/fleet-bus-work-loop.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { runBusWorkLoop } from '../src/core/fleet/bus-work-loop.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

let base: string, root: string, snapshot: string, prompt: string, worktree: string, marker: string;
const child = (markerPath = marker) => [process.execPath, '-e', `
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const valid = input.includes('BEGIN UNTRUSTED BUS REQUEST JSON') && input.includes('fake request data');
    require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({cwd: process.cwd(), valid}));
    console.log('fake worker output');
    console.error('fake worker error');
    process.exitCode = valid ? 0 : 1;
  });`];
const options = () => ({ to: 'worker', owner: 'owner', leaseMs: 60000, waitMs: 500, maxJobs: 1,
  root, snapshot, prompt, argv: child() });
async function run(extra: string[] = [], markerPath = marker) {
  let report = '';
  const stream = new Writable({ write(chunk, _encoding, done) { report += String(chunk); done(); } });
  const code = await cmdFleetBusWorkLoop(['--to', 'worker', '--owner', 'owner', '--lease-ms', '60000',
    '--wait-ms', '500', '--max-jobs', '1', '--snapshot', snapshot, '--prompt', prompt, '--root', root,
    ...extra, '--', ...child(markerPath)], { stdout: stream, stderr: stream });
  return { code, report };
}
function post() {
  expect(appendBusInbox({ id: 'request', from: 'leader', to: 'worker', priority: 'P1', ttl: 120000,
    body: { kind: 'work', text: 'fake request data', argv: ['untrusted executable'] } }, { root }).status).toBe('posted');
}
function expectCompleted() {
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'request', owner: 'other', leaseMs: 60000, root }).status).toBe('completed');
  const inbox = listBusInboxAfter(0, 100, { root });
  expect(inbox.status).toBe('ok');
  if (inbox.status !== 'ok') throw new Error('inbox unavailable');
  expect(inbox.messages.filter(row => row.envelope.to === 'leader').map(row => row.envelope.body))
    .toEqual([expect.objectContaining({ inReplyTo: 'request', succeeded: true, exitCode: 0 })]);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bus-cwd-test-')); root = join(base, 'bus');
  snapshot = join(base, 'snapshot'); prompt = join(base, 'prompt'); worktree = join(base, 'worktree');
  marker = join(worktree, 'marker.json');
  mkdirSync(worktree); mkdirSync(join(base, 'runs'), { mode: 0o700 });
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'CURRENTJOB', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  writeFileSync(prompt, 'fake private prompt');
  vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, 'ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

it('runs the child in the selected worktree and completes the successful reply claim', async () => {
  post();
  const result = await run(['--cwd', worktree], 'marker.json');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.report)).toEqual({ status: 'max-jobs', completed: 1 });
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ cwd: realpathSync(worktree), valid: true });
  expect(result.report).not.toMatch(/fake|untrusted|[a-f0-9]{64}/i);
  expectCompleted();
});

it('rejects malformed and unavailable directories before claiming or starting a child', async () => {
  post();
  for (const cwd of ['relative', join(base, 'missing'), snapshot, '', `bad\0path`]) {
    expect((await run(['--cwd', cwd])).code).toBe(2);
    expect(await runBusWorkLoop({ ...options(), cwd })).toEqual({ status: 'invalid', completed: 0 });
  }
  expect((await run(['--cwd', worktree, '--cwd', worktree])).code).toBe(2);
  expect((await run(['--cwd'])).code).toBe(2);
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(join(root, 'bus-work-claims'))).toBe(false);
  expect(listBusInboxAfter(0, 100, { root })).toMatchObject({ status: 'ok', messages: [expect.objectContaining({ envelope: expect.objectContaining({ id: 'request' }) })] });
});

it('inherits the process directory when cwd is omitted', async () => {
  post();
  const result = await run();
  expect(result.code).toBe(0);
  expect(JSON.parse(result.report)).toEqual({ status: 'max-jobs', completed: 1 });
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ cwd: process.cwd(), valid: true });
  expectCompleted();
});
