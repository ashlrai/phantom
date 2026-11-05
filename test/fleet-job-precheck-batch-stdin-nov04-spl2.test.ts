import { expect, it, vi } from 'vitest';
import { cmdFleetJobPrecheck } from '../src/cli/fleet-job-precheck.js';

const oid = 'a'.repeat(40);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
function fixture(chunks: Uint8Array[], mode: 'fresh' | 'done' | 'error' = 'fresh') {
  const log = vi.fn();
  const error = vi.fn();
  const readFile = vi.fn(async () => { throw new Error('disk read'); });
  const resolveRef = vi.fn(async () => oid);
  const git = {
    exists: vi.fn(async (path: string) => {
      if (mode === 'error' && path === 'src/fail.ts') throw new Error('probe failed');
      return mode !== 'fresh';
    }),
    lastCommit: vi.fn(async () => ({ sha: 'abc1234', subject: 'bridge(RQ-TEST): done' })),
  };
  const readStdin = async function* () { for (const chunk of chunks) yield chunk; };
  return { log, error, readFile, resolveRef, git, readStdin };
}

it('accepts split UTF-8, labels and shared collisions with one snapshot and cached facts', async () => {
  const payload = encode([{ label: 'é-one', markdown: 'src/shared.ts' }, { label: 'two', markdown: 'src/shared.ts' }]);
  const split = payload.indexOf(Buffer.from('é')) + 1;
  const f = fixture([payload.subarray(0, split), payload.subarray(split)], 'done');
  expect(await cmdFleetJobPrecheck(['--batch', '-', '--json'], f)).toBe(3);
  const output = JSON.parse(f.log.mock.calls[0]![0] as string);
  expect(output).toMatchObject({ resolvedRef: oid, collisions: [{ path: 'src/shared.ts', files: ['é-one', 'two'] }] });
  expect(output.results.map((entry: { file: string }) => entry.file)).toEqual(['é-one', 'two']);
  expect(f.resolveRef).toHaveBeenCalledTimes(1);
  expect(f.git.exists).toHaveBeenCalledTimes(1);
  expect(f.git.lastCommit).toHaveBeenCalledTimes(1);
  expect(f.readFile).not.toHaveBeenCalled();
});

it('returns error before likely-done and fresh returns zero', async () => {
  const payload = encode([{ label: 'done', markdown: 'src/done.ts' }, { label: 'fail', markdown: 'src/fail.ts' }]);
  const failed = fixture([payload], 'error');
  expect(await cmdFleetJobPrecheck(['--batch', '-', '--json'], failed)).toBe(2);
  expect(JSON.parse(failed.log.mock.calls[0]![0] as string).counts).toMatchObject({ errors: 1, 'likely-done': 1 });
  expect(await cmdFleetJobPrecheck(['--batch', '-'], fixture([payload]))).toBe(0);
});

it('rejects invalid payloads without resolving, probing or reading disk', async () => {
  const invalid = [
    Buffer.from([0xff]), Buffer.from('{'), encode([]), encode(Array.from({ length: 21 }, (_, i) => ({ label: String(i), markdown: 'x' }))),
    encode([{ label: 'a', markdown: 'x' }, { label: 'a', markdown: 'y' }]),
    encode([{ label: '', markdown: 'x' }]), encode([{ label: 'a'.repeat(201), markdown: 'x' }]),
    encode([{ label: 'a', markdown: ' ' }]), encode([{ label: 'a', markdown: 'é'.repeat(4001) }]),
    encode([{ label: 'a', markdown: 'x', extra: true }]), Buffer.alloc(200001, 32),
  ];
  for (const bytes of invalid) {
    const f = fixture([bytes]);
    expect(await cmdFleetJobPrecheck(['--batch', '-', '--json'], f)).toBe(2);
    expect(f.resolveRef).not.toHaveBeenCalled();
    expect(f.git.exists).not.toHaveBeenCalled();
    expect(f.git.lastCommit).not.toHaveBeenCalled();
    expect(f.readFile).not.toHaveBeenCalled();
  }
  const f = fixture([encode([{ label: 'a', markdown: 'x' }])]);
  expect(await cmdFleetJobPrecheck(['--batch', '-', 'disk.md'], f)).toBe(2);
  expect(f.resolveRef).not.toHaveBeenCalled();
  expect(f.readFile).not.toHaveBeenCalled();
});
