import { afterEach, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexBusAdapter, type CodexBusPorts } from '../src/core/fleet/bus-adapters/codex.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const success = `process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture reply'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));
});`;
async function fixture(script = success) {
  const root = await mkdtemp(join(tmpdir(), 'codex-cancel-fixture-'));
  roots.push(root);
  const engine = join(root, 'engine.cjs');
  await writeFile(engine, script);
  const controller = new AbortController();
  const ports: CodexBusPorts = {
    locus: { registerPeer: vi.fn(async () => {}), unregisterPeer: vi.fn(async () => {}) },
    inbox: { receive: vi.fn().mockResolvedValueOnce({ id: 'm', from: 'fixture', body: 'hello' }).mockResolvedValue(null) },
    router: { reportUsage: vi.fn(async () => {}) }, outbox: { send: vi.fn(async () => {}) },
  };
  const options = { peerId: 'fixture-peer', cwd: root, executable: process.execPath,
    launcherArgs: [engine], signal: controller.signal, timeoutMs: 10_000 };
  return { root, ports, options, controller };
}
function clean(signal: AbortSignal, ports: CodexBusPorts) {
  expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  expect(ports.locus.unregisterPeer).toHaveBeenCalledExactlyOnceWith('fixture-peer');
}

it('pre-abort never registers, receives or executes', async () => {
  const { ports, options, controller } = await fixture('throw new Error("must not run")');
  controller.abort();
  await runCodexBusAdapter(ports, options);
  expect(ports.locus.registerPeer).not.toHaveBeenCalled();
  expect(ports.locus.unregisterPeer).not.toHaveBeenCalled();
  expect(ports.inbox.receive).not.toHaveBeenCalled();
  expect(ports.router.reportUsage).not.toHaveBeenCalled();
  expect(getEventListeners(options.signal, 'abort')).toHaveLength(0);
});

it('kills a silent child, awaits closure, removes scratch HOME and clears its timer', async () => {
  const f = await fixture(`require('node:fs').writeFileSync('started.json', JSON.stringify({pid:process.pid,home:process.env.HOME}));
process.stdin.resume(); setInterval(() => {}, 1000);`);
  const cleared = vi.spyOn(globalThis, 'clearTimeout');
  const pending = runCodexBusAdapter(f.ports, f.options);
  let evidence!: { pid: number; home: string };
  try {
    await vi.waitFor(async () => { evidence = JSON.parse(await readFile(join(f.root, 'started.json'), 'utf8')); });
    await stat(evidence.home);
  } finally { f.controller.abort(); await pending; }
  expect(() => process.kill(evidence.pid, 0)).toThrow();
  await expect(stat(evidence.home)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(cleared).toHaveBeenCalled();
  expect(f.ports.router.reportUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    status: 'failed', inputTokens: null, cachedInputTokens: null, outputTokens: null,
  }));
  expect(f.ports.outbox.send).not.toHaveBeenCalled();
  clean(f.options.signal, f.ports);
});

it.each(['legacy', 'signal-aware'])('interrupts %s inbox wait and observes late rejection', async kind => {
  const f = await fixture();
  let reject!: (error: Error) => void;
  vi.mocked(f.ports.inbox.receive).mockReset().mockImplementation(signal => new Promise((_resolve, fail) => {
    reject = fail;
    if (kind === 'signal-aware') signal?.addEventListener('abort', () => fail(new Error('fixture abort')), { once: true });
  }));
  const pending = runCodexBusAdapter(f.ports, f.options);
  await vi.waitFor(() => expect(f.ports.inbox.receive).toHaveBeenCalledOnce());
  f.controller.abort();
  await pending;
  reject(new Error('late transport failure'));
  await new Promise(resolve => setImmediate(resolve));
  expect(f.ports.router.reportUsage).not.toHaveBeenCalled();
  expect(f.ports.outbox.send).not.toHaveBeenCalled();
  clean(f.options.signal, f.ports);
});

it('completes normally and releases receive and child abort listeners', async () => {
  const f = await fixture();
  await runCodexBusAdapter(f.ports, f.options);
  expect(f.ports.outbox.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'completed', body: 'fixture reply' }));
  expect(f.ports.router.reportUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'completed', inputTokens: 2 }));
  clean(f.options.signal, f.ports);
});

it.each([2_147_483_648, Number.MAX_SAFE_INTEGER, Infinity, NaN, 0, -1, 1.5])('rejects invalid timer %s before registration', async timeoutMs => {
  const f = await fixture();
  await expect(runCodexBusAdapter(f.ports, { ...f.options, timeoutMs })).rejects.toThrow('Invalid Codex limit');
  expect(f.ports.locus.registerPeer).not.toHaveBeenCalled();
  expect(getEventListeners(f.options.signal, 'abort')).toHaveLength(0);
});

it('awaits spawn failure closure and releases listeners', async () => {
  const f = await fixture();
  await runCodexBusAdapter(f.ports, { ...f.options, executable: join(f.root, 'missing') });
  expect(f.ports.outbox.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'failed', body: 'Codex engine failed.' }));
  clean(f.options.signal, f.ports);
});

it('rejects an outbox failure without retrying or acknowledging delivery', async () => {
  const f = await fixture();
  vi.mocked(f.ports.outbox.send).mockRejectedValue(new Error('fixture outbox failure'));
  await expect(runCodexBusAdapter(f.ports, f.options)).rejects.toThrow('fixture outbox failure');
  expect(f.ports.outbox.send).toHaveBeenCalledOnce();
  expect(f.ports.router.reportUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'completed' }));
  clean(f.options.signal, f.ports);
});

it('does not send after cancellation during accounting', async () => {
  const f = await fixture();
  vi.mocked(f.ports.router.reportUsage).mockImplementation(async () => { f.controller.abort(); });
  await runCodexBusAdapter(f.ports, f.options);
  expect(f.ports.outbox.send).not.toHaveBeenCalled();
  clean(f.options.signal, f.ports);
});

it('unregisters once when aborted during registration without receiving', async () => {
  const f = await fixture();
  vi.mocked(f.ports.locus.registerPeer).mockImplementation(async () => { f.controller.abort(); });
  await runCodexBusAdapter(f.ports, f.options);
  expect(f.ports.inbox.receive).not.toHaveBeenCalled();
  clean(f.options.signal, f.ports);
});

it('releases the inbox abort listener when receive rejects', async () => {
  const f = await fixture();
  vi.mocked(f.ports.inbox.receive).mockReset().mockRejectedValue(new Error('fixture receive failure'));
  await expect(runCodexBusAdapter(f.ports, f.options)).rejects.toThrow('fixture receive failure');
  clean(f.options.signal, f.ports);
});
