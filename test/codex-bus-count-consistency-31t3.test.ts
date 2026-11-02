import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexBusAdapter, type CodexBusPorts, type CodexBusUsage } from '../src/core/fleet/bus-adapters/codex.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(usage: Record<string, unknown>, messages = 1) {
  const root = await mkdtemp(join(tmpdir(), 'codex-count-fixture-'));
  roots.push(root);
  const engine = join(root, 'engine.cjs');
  // A trusted local executable emits actual JSONL, including private diagnostics.
  await writeFile(engine, `process.stdin.resume(); process.stdin.on('end', () => {
    process.stderr.write('private diagnostic sentinel');
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture reply'}}));
    console.log(JSON.stringify({type:'turn.completed',usage:${JSON.stringify(usage)}}));
  });`);
  const receive = vi.fn();
  for (let i = 0; i < messages; i++) {
    receive.mockResolvedValueOnce({ id: `m${i}`, from: 'sender', body: 'hello' });
  }
  receive.mockResolvedValue(null);
  const ports: CodexBusPorts = {
    locus: { registerPeer: vi.fn(async () => {}), unregisterPeer: vi.fn(async () => {}) },
    inbox: { receive },
    router: { reportUsage: vi.fn(async () => {}) },
    outbox: { send: vi.fn(async () => {}) },
  };
  const options = { peerId: 'worker', cwd: root, executable: process.execPath, launcherArgs: [engine] };
  return { ports, options };
}

describe('Codex bus token count consistency', () => {
  it.each([
    ['cached exceeds input', { input_tokens: 10, cached_input_tokens: 11, output_tokens: 7 }, [10, null, 7]],
    ['cached equals input', { input_tokens: 10, cached_input_tokens: 10, output_tokens: 7 }, [10, 10, 7]],
    ['zero counts', { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, [0, 0, 0]],
    ['cached exceeds zero', { input_tokens: 0, cached_input_tokens: 1, output_tokens: 0 }, [0, null, 0]],
    ['unknown input', { cached_input_tokens: 4, output_tokens: 7 }, [null, 4, 7]],
    ['unknown cached', { input_tokens: 10, output_tokens: 7 }, [10, null, 7]],
    ['unknown output', { input_tokens: 10, cached_input_tokens: 11 }, [10, null, null]],
    ['safe integer boundary', { input_tokens: Number.MAX_SAFE_INTEGER, cached_input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER }, [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]],
  ])('reports %s without inventing usage', async (_name, usage, expected) => {
    const { ports, options } = await fixture(usage);
    await runCodexBusAdapter(ports, options);
    expect(ports.router.reportUsage).toHaveBeenCalledExactlyOnceWith({
      messageId: 'm0', peerId: 'worker', pool: 'codex-personal', tier: 'work', status: 'completed',
      inputTokens: expected[0], cachedInputTokens: expected[1], outputTokens: expected[2],
    });
    expect(ports.outbox.send).toHaveBeenCalledExactlyOnceWith({
      inReplyTo: 'm0', to: 'sender', from: 'worker', status: 'completed', body: 'fixture reply',
    });
  });

  it.each([
    ['missing', undefined], ['null', null], ['negative', -1], ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['string', '3'], ['boolean', true], ['object', {}],
  ])('rejects %s counters independently', async (_name, invalid) => {
    for (const field of ['input_tokens', 'cached_input_tokens', 'output_tokens'] as const) {
      const usage: Record<string, unknown> = { input_tokens: 10, cached_input_tokens: 3, output_tokens: 7 };
      usage[field] = invalid;
      const { ports, options } = await fixture(usage);
      await runCodexBusAdapter(ports, options);
      const expected: Record<string, number | null> = { input_tokens: 10, cached_input_tokens: 3, output_tokens: 7 };
      expected[field] = null;
      expect(ports.router.reportUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        inputTokens: expected['input_tokens'], cachedInputTokens: expected['cached_input_tokens'], outputTokens: expected['output_tokens'],
      }));
      expect(ports.outbox.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ body: 'fixture reply' }));
    }
  });

  it('awaits exactly one accounting report per turn before delivery', async () => {
    const { ports, options } = await fixture({ input_tokens: 2, cached_input_tokens: 3, output_tokens: 5 }, 2);
    const order: string[] = [];
    vi.mocked(ports.router.reportUsage).mockImplementation(async (usage: CodexBusUsage) => {
      order.push(`account start ${usage.messageId}`);
      await new Promise<void>(resolve => setImmediate(resolve));
      order.push(`account end ${usage.messageId}`);
    });
    vi.mocked(ports.outbox.send).mockImplementation(async reply => { order.push(`send ${reply.inReplyTo}`); });
    await runCodexBusAdapter(ports, options);
    expect(order).toEqual(['account start m0', 'account end m0', 'send m0', 'account start m1', 'account end m1', 'send m1']);
    expect(ports.router.reportUsage).toHaveBeenCalledTimes(2);
    expect(ports.router.reportUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ messageId: 'm0', cachedInputTokens: null, outputTokens: 5 }));
    expect(ports.router.reportUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ messageId: 'm1', cachedInputTokens: null, outputTokens: 5 }));
    expect(ports.outbox.send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ports.outbox.send).mock.calls.map(([reply]) => reply.body)).toEqual(['fixture reply', 'fixture reply']);
  });

  it('keeps the usage report when delivery fails', async () => {
    const { ports, options } = await fixture({ input_tokens: 2, cached_input_tokens: 3, output_tokens: 5 });
    vi.mocked(ports.outbox.send).mockRejectedValue(new Error('fixture delivery failure'));
    await expect(runCodexBusAdapter(ports, options)).rejects.toThrow('fixture delivery failure');
    expect(ports.router.reportUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 2, cachedInputTokens: null, outputTokens: 5 }));
    expect(ports.outbox.send).toHaveBeenCalledOnce();
  });
});
