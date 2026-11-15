/** RQ-PARITY-GROK-DEVIN-PEERS: both CLI bus adapters wired to the same injected
 * Locus peers plane — peers registration, thread membership and the router
 * usage feed — with the provider process boundary fully mocked. No real CLI,
 * account, network or Locus session is used; mailbox I/O stays real so atomic
 * delivery is still exercised. */
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  devinBusAdapter, runDevinBusAdapter,
  type DevinBusAdapterDeps, type DevinBusLocusPeers, type DevinBusRequest, type DevinBusRouterUsage,
} from '../src/core/fleet/bus-adapters/devin.js';
import {
  grokBusAdapter, runGrokBusAdapter,
  type GrokBusAdapterDeps, type GrokBusLocusPeers, type GrokBusRequest, type GrokBusRouterUsage,
} from '../src/core/fleet/bus-adapters/grok.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

class FakeChild extends EventEmitter {
  pid?: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
  complete(output: string, code = 0): void {
    if (output) this.stdout.write(output);
    this.exitCode = code;
    this.emit('close', code);
  }
}

/** A grok headless stream carrying one successful reply with token usage. */
function grokResult(text: string, usage?: { input_tokens: number; output_tokens: number }): string {
  return `${JSON.stringify({ type: 'result', subtype: 'success', result: text, ...(usage ? { usage } : {}) })}\n`;
}

// FAKE credential-shaped values are constructed at runtime and never logged.
function fakeCredential(): string { return ['ghp', '_', 'FAKE' + 'x'.repeat(40)].join(''); }

const THREAD = 'thr-01JZZY0EXAMPLE';

interface StubLocus extends DevinBusLocusPeers, GrokBusLocusPeers {
  registerPeer: ReturnType<typeof vi.fn>;
  joinThread: ReturnType<typeof vi.fn>;
  reportUsage: ReturnType<typeof vi.fn>;
}

function stubLocus(overrides: Partial<StubLocus> = {}): StubLocus {
  return {
    registerPeer: vi.fn(async () => undefined),
    joinThread: vi.fn(async () => undefined),
    reportUsage: vi.fn(async () => undefined),
    ...overrides,
  };
}

let root: string;
let inboxPath: string;
let outboxPath: string;
let children: FakeChild[];
let replyOutput: string;
let replyCode: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bus-peers-test-'));
  inboxPath = join(root, 'inbox.txt');
  outboxPath = join(root, 'outbox.txt');
  await writeFile(inboxPath, 'Summarize the build status.');
  await writeFile(outboxPath, 'Previous reply');
  children = [];
  replyOutput = 'FAKE reply';
  replyCode = 0;
  // Each spawn gets a fresh child — a test can run both adapters back to back.
  spawnMock.mockReset().mockImplementation(() => {
    const spawned = new FakeChild();
    children.push(spawned);
    const output = replyOutput;
    const code = replyCode;
    queueMicrotask(() => spawned.complete(output, code));
    return spawned;
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const spawned of children) { spawned.stdout.destroy(); spawned.stderr.destroy(); }
  await rm(root, { recursive: true, force: true });
});

const admit = { authorize: async () => ({ command: ['/FAKE/bin'], check: () => {} }) };

function devinDeps(locus?: StubLocus): DevinBusAdapterDeps {
  return { ...admit, ...(locus ? { locus } : {}) };
}

function grokDeps(locus?: StubLocus): GrokBusAdapterDeps {
  return { ...admit, ...(locus ? { locus } : {}) };
}

const devinRequest = (): DevinBusRequest => ({ inboxPath, outboxPath, cwd: root, threadId: THREAD });
const grokRequest = (): GrokBusRequest => ({ inboxPath, outboxPath, cwd: root, threadId: THREAD });

/** Devin run against the fake child: print mode answers with plain stdout text. */
async function devinTurn(deps: DevinBusAdapterDeps, request: DevinBusRequest = devinRequest()) {
  replyOutput = 'FAKE reply';
  return runDevinBusAdapter(request, deps);
}

/** Grok run against the fake child: headless stream with a success result. */
async function grokTurn(deps: GrokBusAdapterDeps, request: GrokBusRequest = grokRequest(), usage?: { input_tokens: number; output_tokens: number }) {
  replyOutput = grokResult('Reply ✓', usage);
  return runGrokBusAdapter(request, deps);
}

function spawnEnv(): NodeJS.ProcessEnv {
  return (spawnMock.mock.calls[0]![2] as SpawnOptions).env as NodeJS.ProcessEnv;
}

describe('Devin bus adapter — Locus peers wiring', () => {
  it('registers as a peer and joins the thread before spawning, then feeds router usage', async () => {
    const locus = stubLocus();
    const result = await devinTurn(devinDeps(locus));
    expect(result.peers).toEqual({ wired: true, registered: true, joined: true, usageReported: true });
    expect(locus.registerPeer).toHaveBeenCalledWith({ adapter: 'devin', peer: 'devin-cli', thread: THREAD });
    expect(locus.joinThread).toHaveBeenCalledWith({ adapter: 'devin', peer: 'devin-cli', thread: THREAD });
    const usage = locus.reportUsage.mock.calls[0]![0] as DevinBusRouterUsage;
    expect(usage).toMatchObject({ adapter: 'devin', peer: 'devin-cli', thread: THREAD, model: 'swe-2-high' });
    expect(usage.replyBytes).toBe(result.bytes);
    expect(usage.durationMs).toBeGreaterThanOrEqual(0);
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    // Registration and membership precede the child; the usage feed follows it.
    expect(locus.registerPeer.mock.invocationCallOrder[0]!).toBeLessThan(spawnMock.mock.invocationCallOrder[0]!);
    expect(locus.joinThread.mock.invocationCallOrder[0]!).toBeLessThan(spawnMock.mock.invocationCallOrder[0]!);
    expect(locus.registerPeer.mock.invocationCallOrder[0]!).toBeLessThan(locus.joinThread.mock.invocationCallOrder[0]!);
    expect(locus.reportUsage.mock.invocationCallOrder[0]!).toBeGreaterThan(spawnMock.mock.invocationCallOrder[0]!);
    expect(await readFile(outboxPath, 'utf8')).toBe('FAKE reply');
  });

  it('keeps GH_TOKEN and other credentials out of the child env while wired', async () => {
    const fake = fakeCredential();
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'gh_token', 'github_token', 'ANTHROPIC_API_KEY']) vi.stubEnv(name, fake);
    await devinTurn(devinDeps(stubLocus()));
    const env = spawnEnv();
    for (const name of Object.keys(env)) expect(/TOKEN|SECRET|PASSWORD|API_?KEY/i.test(name)).toBe(false);
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
  });
});

describe('Grok bus adapter — Locus peers wiring', () => {
  it('registers as a peer and joins the thread before spawning, then feeds router usage', async () => {
    const locus = stubLocus();
    const result = await grokTurn(grokDeps(locus), grokRequest(), { input_tokens: 11, output_tokens: 7 });
    expect(result.peers).toEqual({ wired: true, registered: true, joined: true, usageReported: true });
    expect(locus.registerPeer).toHaveBeenCalledWith({ adapter: 'grok', peer: 'grok-cli', thread: THREAD });
    expect(locus.joinThread).toHaveBeenCalledWith({ adapter: 'grok', peer: 'grok-cli', thread: THREAD });
    const usage = locus.reportUsage.mock.calls[0]![0] as GrokBusRouterUsage;
    expect(usage).toMatchObject({ adapter: 'grok', peer: 'grok-cli', thread: THREAD, model: 'grok-4.7' });
    expect(usage.inputTokens).toBe(11);
    expect(usage.outputTokens).toBe(7);
    expect(usage.replyBytes).toBe(result.bytes);
    expect(locus.registerPeer.mock.invocationCallOrder[0]!).toBeLessThan(spawnMock.mock.invocationCallOrder[0]!);
    expect(locus.joinThread.mock.invocationCallOrder[0]!).toBeLessThan(spawnMock.mock.invocationCallOrder[0]!);
    expect(locus.reportUsage.mock.invocationCallOrder[0]!).toBeGreaterThan(spawnMock.mock.invocationCallOrder[0]!);
    expect(await readFile(outboxPath, 'utf8')).toBe('Reply ✓');
  });

  it('keeps GH_TOKEN and other credentials out of the child env while wired', async () => {
    const fake = fakeCredential();
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'gh_token', 'github_token', 'XAI_API_KEY']) vi.stubEnv(name, fake);
    await grokTurn(grokDeps(stubLocus()));
    const env = spawnEnv();
    for (const name of Object.keys(env)) expect(/TOKEN|SECRET|PASSWORD|API_?KEY/i.test(name)).toBe(false);
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
  });
});

describe('Peers wiring — shared contract', () => {
  it('exposes frozen router-hint metadata on both adapters', () => {
    expect(devinBusAdapter).toEqual({ id: 'devin-cli', lastResort: true, run: runDevinBusAdapter });
    expect(grokBusAdapter).toEqual({ id: 'grok-cli', lastResort: true, run: runGrokBusAdapter });
    expect(Object.isFrozen(devinBusAdapter)).toBe(true);
    expect(Object.isFrozen(grokBusAdapter)).toBe(true);
  });

  it('runs unwired without a thread id, on both adapters', async () => {
    const locus = stubLocus();
    const devin = await devinTurn(devinDeps(locus), { inboxPath, outboxPath, cwd: root });
    expect(devin.peers).toEqual({ wired: false, registered: false, joined: false, usageReported: false });
    replyOutput = 'FAKE reply';
    await writeFile(outboxPath, 'Previous reply');
    const grok = await grokTurn(grokDeps(locus), { inboxPath, outboxPath, cwd: root });
    expect(grok.peers).toEqual({ wired: false, registered: false, joined: false, usageReported: false });
    expect(locus.registerPeer).not.toHaveBeenCalled();
    expect(locus.joinThread).not.toHaveBeenCalled();
    expect(locus.reportUsage).not.toHaveBeenCalled();
  });

  it('runs unwired without a plane, on both adapters', async () => {
    const devin = await devinTurn(devinDeps());
    expect(devin.peers.wired).toBe(false);
    replyOutput = 'FAKE reply';
    const grok = await grokTurn(grokDeps());
    expect(grok.peers.wired).toBe(false);
  });

  it.each(['not a thread', '', 'thr\x00x', 't'.repeat(129)])(
    'rejects a malformed devin thread id %j before any wiring', async threadId => {
      const locus = stubLocus();
      await expect(devinTurn(devinDeps(locus), { ...devinRequest(), threadId }))
        .rejects.toMatchObject({ code: 'invalid-request' });
      expect(locus.registerPeer).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(await readFile(outboxPath, 'utf8')).toBe('Previous reply');
    },
  );

  it.each(['not a thread', '', 'thr\x00x', 't'.repeat(129)])(
    'rejects a malformed grok thread id %j before any wiring', async threadId => {
      const locus = stubLocus();
      await expect(grokTurn(grokDeps(locus), { ...grokRequest(), threadId }))
        .rejects.toMatchObject({ code: 'invalid-request' });
      expect(locus.registerPeer).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(await readFile(outboxPath, 'utf8')).toBe('Previous reply');
    },
  );

  it('reports only the methods a partial plane implements, on both adapters', async () => {
    // A plane implementing joinThread only: registerPeer absent must read false, never true.
    const partial = { joinThread: vi.fn(async () => undefined) };
    const devin = await devinTurn(devinDeps(partial as unknown as StubLocus));
    expect(devin.peers).toEqual({ wired: true, registered: false, joined: true, usageReported: false });
    expect(partial.joinThread).toHaveBeenCalledWith({ adapter: 'devin', peer: 'devin-cli', thread: THREAD });
    const grok = await grokTurn(grokDeps({ reportUsage: vi.fn(async () => undefined) } as unknown as StubLocus));
    expect(grok.peers).toEqual({ wired: true, registered: false, joined: false, usageReported: true });
  });

  it('still delivers the devin reply when the plane throws', async () => {
    const locus = stubLocus({
      registerPeer: vi.fn(async () => { throw new Error('FAKE plane down'); }),
      joinThread: vi.fn(() => { throw new Error('FAKE plane down'); }),
      reportUsage: vi.fn(async () => Promise.reject(new Error('FAKE plane down'))),
    });
    const result = await devinTurn(devinDeps(locus));
    expect(result.peers).toEqual({ wired: true, registered: false, joined: false, usageReported: false });
    expect(await readFile(outboxPath, 'utf8')).toBe('FAKE reply');
  });

  it('still delivers the grok reply when the plane throws', async () => {
    const locus = stubLocus({
      registerPeer: vi.fn(async () => { throw new Error('FAKE plane down'); }),
      joinThread: vi.fn(() => { throw new Error('FAKE plane down'); }),
      reportUsage: vi.fn(async () => Promise.reject(new Error('FAKE plane down'))),
    });
    const result = await grokTurn(grokDeps(locus));
    expect(result.peers).toEqual({ wired: true, registered: false, joined: false, usageReported: false });
    expect(await readFile(outboxPath, 'utf8')).toBe('Reply ✓');
  });

  it('never reports devin usage for a failed turn', async () => {
    replyOutput = 'partial';
    replyCode = 7;
    const locus = stubLocus();
    await expect(devinTurn(devinDeps(locus))).rejects.toMatchObject({ code: 'failed' });
    expect(locus.registerPeer).toHaveBeenCalledOnce();
    expect(locus.joinThread).toHaveBeenCalledOnce();
    expect(locus.reportUsage).not.toHaveBeenCalled();
    expect(await readFile(outboxPath, 'utf8')).toBe('Previous reply');
    expect((await readdir(root)).filter(p => p.includes('-reply-'))).toEqual([]);
  });

  it('never reports grok usage for a failed turn', async () => {
    replyOutput = 'partial';
    replyCode = 7;
    const locus = stubLocus();
    await expect(grokTurn(grokDeps(locus))).rejects.toMatchObject({ code: 'failed' });
    expect(locus.registerPeer).toHaveBeenCalledOnce();
    expect(locus.joinThread).toHaveBeenCalledOnce();
    expect(locus.reportUsage).not.toHaveBeenCalled();
    expect(await readFile(outboxPath, 'utf8')).toBe('Previous reply');
    expect((await readdir(root)).filter(p => p.includes('-reply-'))).toEqual([]);
  });
});
