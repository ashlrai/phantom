import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGuardianLoop } from '../src/cli/fleet-guardian-loop.js';
import { cmdFleetGuardianStreamContinue } from '../src/cli/fleet-guardian-stream-continue.js';
import type { GuardianDrainDeps } from '../src/core/fleet/guardian-retry-drain.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

it('passes actual loop stream summary unchanged with explicit flags and status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-stream-')); dirs.push(dir);
  await mkdir(join(dir, 'out'));
  let time = 0, selected = 0;
  const lines: string[] = [];
  const args = ['--manifest', join(dir, 'manifest'), '--source-state', join(dir, 'state'), '--output-dir', join(dir, 'out'), '--duration-ms', '1500', '--interval-ms', '1000', '--max-retries', '2', '--timeout-ms', '5000'];
  const select = async () => ({ repo: `/fake/repo-${++selected}`, sha: 'a'.repeat(40) });
  const prepare = async (o: { outputState: string }) => { await writeFile(o.outputState, 'state', { flag: 'wx', mode: 0o600 }); };
  const verify = async () => ({ state: 'ran', summary: { deadlineExceeded: false, cancelled: false } }) as unknown as GuardianVerifyExclusiveResult;
  expect(await cmdFleetGuardianLoop([...args, '--apply', '--stream'], { select: select as GuardianDrainDeps['select'], prepare: prepare as GuardianDrainDeps['prepare'], verify, now: () => time, sleep: async ms => { time += ms; }, writeLine: line => { lines.push(line); } })).toBe(0);
  expect(lines.map(l => JSON.parse(l).record)).toEqual(['attempt', 'attempt', 'pass', 'attempt', 'attempt', 'pass', 'summary']);
  for (const flags of [[], ['--apply', '--json']]) {
    const delegate = vi.fn(async (_args: string[], deps?: { readInput?: () => Promise<string | Uint8Array> }) => { expect(await deps!.readInput!()).toBe(lines.at(-1)!.trimEnd()); return 5; });
    expect(await cmdFleetGuardianStreamContinue(['--stdin', ...flags], { input: lines, delegate })).toBe(5);
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(delegate.mock.calls[0]![0]).toEqual(['--stdin', ...flags]);
  }
});

it('consumes many records, CRLF, blank lines and split UTF-8 incrementally', async () => {
  const summary = '{"record":"summary","name":"é"}';
  async function* input() {
    for (let i = 0; i < 20000; i++) yield '{"record":"pass"}\r\n';
    const bytes = Buffer.from(`\r\n${summary}\r\n\n`);
    for (const byte of bytes) yield Uint8Array.of(byte);
  }
  const delegate = vi.fn(async (_args: string[], deps?: { readInput?: () => Promise<string | Uint8Array> }) => { expect(await deps!.readInput!()).toBe(`${summary}\r`); return 0; });
  expect(await cmdFleetGuardianStreamContinue(['--stdin'], { input: input(), delegate })).toBe(0);
  expect(delegate).toHaveBeenCalledTimes(1);
});

it('refuses invalid streams and input errors without delegation', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const delegate = vi.fn(async () => 0);
  const s = '{"record":"summary"}\n';
  const invalid = ['{\n', `${'x'.repeat(32769)}\n`, '{"record":"pass"}\n', s + s, s + '{"record":"attempt"}\n', '{"record":"other"}\n' + s, s.trimEnd(), new Uint8Array([255, 10])];
  for (const chunk of invalid) expect(await cmdFleetGuardianStreamContinue(['--stdin'], { input: [chunk], delegate })).toBe(2);
  async function* broken() { yield s; throw new Error('private'); }
  expect(await cmdFleetGuardianStreamContinue(['--stdin'], { input: broken(), delegate })).toBe(2);
  expect(delegate).not.toHaveBeenCalled();
});

it('rejects invalid options before reading', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const read = vi.fn();
  const input = { [Symbol.asyncIterator]: () => { read(); throw new Error(); } };
  for (const args of [[], ['--stdin', '--unknown'], ['--stdin', '--stdin'], ['--stdin', '--manifest'], ['--stdin', '--json', '--stream']]) {
    expect(await cmdFleetGuardianStreamContinue(args, { input })).toBe(2);
  }
  expect(read).not.toHaveBeenCalled();
});
