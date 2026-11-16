import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetWorkState } from '../src/cli/fleet-work-state.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function run(body: unknown, json: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'work-state-identity-'));
  roots.push(root);
  const file = join(root, 'evidence.json');
  const input = JSON.stringify(body);
  await writeFile(file, input);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdFleetWorkState(['--evidence', file, ...(json ? ['--json'] : [])]);
  expect(await readFile(file, 'utf8')).toBe(input);
  expect(await readdir(root)).toEqual(['evidence.json']);
  const output = log.mock.calls.map(call => call[0]);
  const errors = error.mock.calls.map(call => call[0]);
  log.mockRestore();
  error.mockRestore();
  return { code, output, errors };
}

it.each([false, true])('rejects blank identities without output (json=%s)', async json => {
  for (const id of ['', '   ', '\t\n']) {
    const result = await run({ id }, json);
    expect(result).toEqual({ code: 2, output: [], errors: ['error: invalid evidence: evidence: id must be a non-empty string'] });
  }
});

it.each([false, true])('validates the entire array before output (json=%s)', async json => {
  const result = await run([{ id: 'valid-1' }, { id: ' \t\n' }], json);
  expect(result).toEqual({ code: 2, output: [], errors: ['error: invalid evidence: item 1: id must be a non-empty string'] });
});

it.each([false, true])('preserves nonblank identity bytes (json=%s)', async json => {
  const id = '  RQ/315:part#1?!  ';
  const result = await run({ id, receivedAt: '2026-11-12T22:29:00Z' }, json);
  expect(result.code).toBe(0);
  expect(result.errors).toEqual([]);
  if (json) expect(JSON.parse(result.output[0] as string)[0].id).toBe(id);
  else expect(result.output).toEqual([`${id} RECEIVED as-of=2026-11-12T22:29:00Z source=receivedAt missing=named owner,durable claim receipt`]);
});
