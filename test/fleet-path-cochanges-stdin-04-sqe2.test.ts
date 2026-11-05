import { describe, expect, it, vi } from 'vitest';
import { cmdFleetPathCochanges } from '../src/cli/fleet-path-cochanges.js';
import type { pathCochanges } from '../src/core/fleet/path-cochanges.js';

const report = {
  path: 'file', resolvedRef: 'a'.repeat(40), sampledCount: 1, examinedCount: 1,
  commitsTruncated: false, matchesTruncated: true, pathsTruncated: true, omittedPaths: 2,
  paths: [{ path: 'other', count: 1, evidence: [{ sha: 'b'.repeat(40), jobId: 'RQ-TEST-1' }] }],
  notice: 'Evidence only.',
};
const bytes = (value: string) => Buffer.from(value);
async function* stream(...chunks: Uint8Array[]) { yield* chunks; }
function setup(input: AsyncIterable<Uint8Array> = stream()) {
  const read = vi.fn<typeof pathCochanges>().mockResolvedValue(report);
  const output = vi.fn<(text: string) => void>();
  const error = vi.fn<(text: string) => void>();
  return { read, output, error, stdin: input };
}

describe('fleet path-cochanges stdin', () => {
  it('decodes split UTF-8 and preserves an odd literal path and limit', async () => {
    const path = '-dir/雪 *?[x]';
    const encoded = bytes(JSON.stringify(path));
    const split = encoded.indexOf(bytes('雪')) + 1;
    const deps = setup(stream(encoded.subarray(0, split), encoded.subarray(split)));
    expect(await cmdFleetPathCochanges(['--stdin', '--limit', '3', '--json'], deps)).toBe(0);
    expect(deps.read).toHaveBeenCalledExactlyOnceWith(path, { limit: 3 });
    expect(JSON.parse(deps.output.mock.calls[0]![0])).toEqual(report);
  });

  it('accepts exactly 16 KiB and rejects overflow before the reader', async () => {
    const boundary = '"' + 'a'.repeat(16382) + '"';
    const good = setup(stream(bytes(boundary)));
    expect(await cmdFleetPathCochanges(['--stdin'], good)).toBe(0);
    expect(good.read).toHaveBeenCalledOnce();
    const bad = setup(stream(bytes(boundary), bytes(' ')));
    expect(await cmdFleetPathCochanges(['--stdin'], bad)).toBe(2);
    expect(bad.read).not.toHaveBeenCalled();
  });

  it.each([
    '', 'raw line', '{', '{}', '[]', 'null', '""', '"../x"', '"/x"',
    '"C:/x"', '"a/./b"', '"a//b"', '"a\\\\b"', '"a\\n b"',
  ])('rejects invalid input without calling the reader: %j', async input => {
    const deps = setup(stream(bytes(input)));
    expect(await cmdFleetPathCochanges(['--stdin'], deps)).toBe(2);
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(deps.read).not.toHaveBeenCalled();
  });

  it('rejects invalid UTF-8 and stream failures', async () => {
    for (const input of [stream(Uint8Array.of(0xff)), (async function* () { yield bytes(''); throw new Error('secret'); })()]) {
      const deps = setup(input);
      expect(await cmdFleetPathCochanges(['--stdin'], deps)).toBe(2);
      expect(deps.read).not.toHaveBeenCalled();
      expect(deps.error.mock.calls[0]![0]).not.toContain('secret');
    }
  });

  it.each([
    ['--stdin', 'file'], ['file', '--stdin'], ['--stdin', '--stdin'],
    ['--stdin', '--json', '--json'], ['--stdin', '--limit', '1', '--limit', '2'],
    ['--stdin', '--unknown'], ['--stdin', '--limit', '0'], ['--stdin', '--limit'],
  ])('rejects invalid options %j', async (...args) => {
    const deps = setup(stream(bytes('"file"')));
    expect(await cmdFleetPathCochanges(args, deps)).toBe(2);
    expect(deps.read).not.toHaveBeenCalled();
  });

  it('preserves positional and -- behavior and text evidence', async () => {
    const deps = setup();
    expect(await cmdFleetPathCochanges(['--limit', '2', '--', '-file'], deps)).toBe(0);
    expect(deps.read).toHaveBeenCalledExactlyOnceWith('-file', { limit: 2 });
    const text = deps.output.mock.calls.flat().join('\n');
    expect(text).toContain('RQ-TEST-1');
    expect(text).toContain('matches=true, paths=true; omitted paths=2');
    expect(text).toContain('Evidence only.');
    expect(await cmdFleetPathCochanges(['file'], setup())).toBe(0);
    expect(await cmdFleetPathCochanges(['-file'], setup())).toBe(2);
  });

  it('does not consume stdin or read on help and hides reader errors', async () => {
    const input = { [Symbol.asyncIterator]: () => { throw new Error('consumed'); } };
    const deps = setup(input);
    expect(await cmdFleetPathCochanges(['--help'], deps)).toBe(0);
    expect(deps.read).not.toHaveBeenCalled();
    deps.read.mockRejectedValue(new Error('private'));
    expect(await cmdFleetPathCochanges(['file'], deps)).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('error: unable to read path cochanges from git');
  });
});
