import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdRouterQueue } from '../src/cli/router-queue.js';
import { enqueueRouterFollowup, routerQueueAskFanout } from '../src/core/fleet/router-queue.js';

vi.mock('../src/core/fleet/router-queue.js', () => ({
  completeRouterJob: vi.fn(),
  enqueueRouterFollowup: vi.fn(() => ({ accepted: 'merged' })),
  readRouterQueue: vi.fn(),
  routerQueueAskFanout: vi.fn(() => ({ accepted: 'ask' })),
}));

const invalid = { code: 1, output: [{ error: 'queue-unavailable-or-invalid' }] };

async function run(args: string[], chunks: (string | Buffer)[]) {
  const output: unknown[] = [];
  const input = (async function* () { yield* chunks; })();
  const code = await cmdRouterQueue(args, { input, output: (value) => output.push(value) });
  return { code, output };
}

describe('router queue input decoding', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['ask', 'merged'] as const)('preserves split Unicode in %s records', async (command) => {
    const record = { task: 'café 🦊 漢字' };
    const bytes = Buffer.from(JSON.stringify(record));
    // Split every byte so all multi-byte sequences cross chunk boundaries.
    const chunks = Array.from(bytes, (_, index) => bytes.subarray(index, index + 1));
    expect(await run([command, '--json'], chunks)).toEqual({ code: 0, output: [{ accepted: command }] });
    const target = command === 'ask' ? routerQueueAskFanout : enqueueRouterFollowup;
    expect(target).toHaveBeenCalledExactlyOnceWith(record);
  });

  it.each(['ask', 'merged'] as const)('accepts plain valid %s records', async (command) => {
    const record = { schema: command === 'ask' ? 'ask.v1' : 'merged.v1', task: 'local fixture' };
    expect(await run([command], [JSON.stringify(record)])).toEqual({ code: 0, output: [{ accepted: command }] });
    expect(command === 'ask' ? routerQueueAskFanout : enqueueRouterFollowup).toHaveBeenCalledExactlyOnceWith(record);
  });

  it.each([
    ['invalid continuation', [0xc3, 0x28]],
    ['overlong sequence', [0xc0, 0xaf]],
    ['encoded surrogate', [0xed, 0xa0, 0x80]],
    ['stray continuation', [0x80]],
  ])('rejects %s without forwarding or echoing input', async (_name, badBytes) => {
    for (const command of ['ask', 'merged']) {
      const chunks = [Buffer.from('{"task":"SECRET_'), Buffer.from(badBytes), Buffer.from('"}')];
      expect(await run([command], chunks)).toEqual(invalid);
    }
    expect(routerQueueAskFanout).not.toHaveBeenCalled();
    expect(enqueueRouterFollowup).not.toHaveBeenCalled();
  });

  it.each(['ask', 'merged'])('rejects a truncated %s sequence at end of input', async (command) => {
    expect(await run([command], [Buffer.from('{"task":"SECRET_'), Buffer.from([0xf0, 0x9f, 0xa6])])).toEqual(invalid);
    expect(routerQueueAskFanout).not.toHaveBeenCalled();
    expect(enqueueRouterFollowup).not.toHaveBeenCalled();
  });

  it.each([['ask', 16 * 1024], ['merged', 4096]] as const)('enforces the %s cap in bytes', async (command, cap) => {
    const prefix = '{"task":"';
    const suffix = '"}';
    const atLimit = prefix + 'x' + 'é'.repeat((cap - Buffer.byteLength(prefix + suffix) - 1) / 2) + suffix;
    expect(Buffer.byteLength(atLimit)).toBe(cap);
    expect(await run([command], [atLimit])).toEqual({ code: 0, output: [{ accepted: command }] });
    vi.clearAllMocks();
    expect(await run([command], [atLimit, 'é'])).toEqual(invalid);
    expect(routerQueueAskFanout).not.toHaveBeenCalled();
    expect(enqueueRouterFollowup).not.toHaveBeenCalled();
  });

  it.each(['ask', 'merged'])('rejects %s JSON with trailing garbage', async (command) => {
    expect(await run([command], ['{"task":"SECRET"} trailing'])).toEqual(invalid);
    expect(routerQueueAskFanout).not.toHaveBeenCalled();
    expect(enqueueRouterFollowup).not.toHaveBeenCalled();
  });

  it.each([
    ['ask', '--json', '--json'],
    ['merged', '--json', '--json'],
    ['ask', 'extra'],
    ['merged', '--json', 'extra'],
  ])('rejects invalid arguments %j without consuming stdin', async (...args) => {
    const output: unknown[] = [];
    const next = vi.fn(() => { throw new Error('stdin was consumed'); });
    const input: AsyncIterable<Buffer> = { [Symbol.asyncIterator]: () => ({ next }) };
    expect(await cmdRouterQueue(args, { input, output: (value) => output.push(value) })).toBe(2);
    expect(output).toEqual([expect.objectContaining({ error: 'usage' })]);
    expect(next).not.toHaveBeenCalled();
    expect(routerQueueAskFanout).not.toHaveBeenCalled();
    expect(enqueueRouterFollowup).not.toHaveBeenCalled();
  });
});
