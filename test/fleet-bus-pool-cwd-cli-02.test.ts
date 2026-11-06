import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { cmdFleetBusWorkPool } from '../src/cli/fleet-bus-work-pool.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

let base: string, root: string, snapshot: string, prompt: string, marker: string, script: string, cwd: string;
const claimsFile = () => join(root, 'bus-work-claims', 'claims.json');
const markerLines = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : [];
const post = (body: Record<string, unknown> = { kind: 'work' }) => expect(appendBusInbox({ id: 'request', from: 'leader', to: 'worker',
  priority: 'P1', ttl: 120_000, body } satisfies BusEnvelope, { root }).status).toBe('posted');
const baseArgs = () => ['--to', 'worker', '--owner', 'pool', '--lease-ms', '60000', '--wait-ms', '500', '--max-jobs', '1',
  '--concurrency', '1', '--snapshot', snapshot, '--prompt', prompt, '--root', root];
const tail = () => ['--', process.execPath, script, marker];

async function run(argv: string[]) {
  let out = '', err = '';
  const sink = (write: (text: string) => void) => new Writable({ write(chunk, _encoding, done) { write(String(chunk)); done(); } });
  const code = await cmdFleetBusWorkPool(argv, { stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
  return { code, out, err, result: out.startsWith('{') ? JSON.parse(out) : undefined };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bus-pool-cwd-cli-')); root = join(base, 'bus');
  snapshot = join(base, 'snapshot'); prompt = join(base, 'prompt'); marker = join(base, 'marker'); script = join(base, 'cwd-child.cjs');
  cwd = join(base, 'worktree');
  mkdirSync(cwd); mkdirSync(join(base, 'runs'), { mode: 0o700 });
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'CURRENTJOB', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  writeFileSync(prompt, 'prompt');
  // Harmless fake child: drain stdin, then record its working directory at the marker path given as argv.
  writeFileSync(script, `const fs = require('node:fs');
    const file = process.argv[2];
    process.stdin.resume();
    process.stdin.on('end', () => { fs.appendFileSync(file, process.cwd() + '\\n'); console.log('done'); });`);
  vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, 'ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

it('lists --cwd in help and exits 0 without acting', async () => {
  const result = await run(['--help']);
  expect(result.code).toBe(0);
  expect(result.out).toContain('[--cwd <absolute directory>]');
  expect(existsSync(claimsFile())).toBe(false);
});

it('runs the pool child in the selected directory, not in the coordinator directory', async () => {
  post({ kind: 'work', cwd: join(base, 'from-body'), argv: ['/bin/false'], env: { PATH: '' } });
  const result = await run([...baseArgs(), '--cwd', cwd, ...tail()]);
  expect(result).toMatchObject({ code: 0, result: { status: 'max-jobs', completed: 1 } });
  expect(markerLines()).toEqual([realpathSync(cwd)]);
  expect(readFileSync(claimsFile(), 'utf8')).toContain('"completedAt"');
});

it('inherits the coordinator directory when --cwd is omitted', async () => {
  post();
  const result = await run([...baseArgs(), ...tail()]);
  expect(result).toMatchObject({ code: 0, result: { status: 'max-jobs', completed: 1 } });
  expect(markerLines()).toEqual([realpathSync(process.cwd())]);
});

// Cases are thunks because the fixture paths exist only after beforeEach.
it.each<[string, () => string[]]>([
  ['relative path', () => ['--cwd', 'worktree']],
  ['nonexistent directory', () => ['--cwd', join(base, 'missing')]],
  ['regular file', () => { writeFileSync(join(base, 'a-file'), 'x'); return ['--cwd', join(base, 'a-file')]; }],
  ['duplicate flag', () => ['--cwd', cwd, '--cwd', cwd]],
  ['missing value', () => ['--cwd']],
  ['empty value', () => ['--cwd', '']],
  ['flag-like value', () => ['--cwd', '--max-jobs']],
  ['NUL byte', () => ['--cwd', `${cwd}\0x`]],
])('refuses --cwd with %s before any claim or child', async (_name, extra) => {
  post();
  const result = await run([...baseArgs(), ...extra(), ...tail()]);
  expect(result.code).toBe(2);
  expect(result.out).toBe('');
  expect(result.err).toMatch(/^Usage: ashlr fleet bus-work-pool/);
  expect(existsSync(claimsFile())).toBe(false);
  expect(existsSync(marker)).toBe(false);
});

it('leaves the request unclaimed after refusal so a later valid run still completes it', async () => {
  post();
  expect((await run([...baseArgs(), '--cwd', 'relative', ...tail()])).code).toBe(2);
  expect(existsSync(claimsFile())).toBe(false);
  const result = await run([...baseArgs(), '--cwd', cwd, ...tail()]);
  expect(result).toMatchObject({ code: 0, result: { status: 'max-jobs', completed: 1 } });
  expect(markerLines()).toEqual([realpathSync(cwd)]);
});
