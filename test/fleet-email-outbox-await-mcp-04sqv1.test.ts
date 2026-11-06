/**
 * RQ-PHX-EMAILMCPWAIT04SQV1 — fleet_email_outbox_await: a bounded wait for
 * one named reply artifact to leave queued through the isolated fleet MCP
 * server. Evidence only — never permission to send.
 * Hermetic: temp-dir runs roots, fake addresses, in-memory transports; no
 * daemon, transport, real mail or provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import {
  DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS,
  MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS,
  parseFleetEmailOutboxAwaitArgs, readFleetEmailOutboxAwait, type FleetEmailOutboxAwaitDeps,
} from '../src/mcp/fleet-email-outbox-await.js';
import { awaitEmailOutbox, type AwaitOptions, type AwaitResult } from '../src/core/comms/email-outbox-await.js';
import { EMAIL_DROP_CONFIG_FILE } from '../src/core/comms/email-drop-config.js';
import { readFleetEmailOutbox } from '../src/mcp/fleet-email-outbox.js';

const connections: Client[] = [];
let root: string;
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-email-outbox-await-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function connect(readers: Pick<FleetReaders, 'emailOutboxAwait' | 'emailOutbox'> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers });
  const client = new Client({ name: 'email-outbox-await-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
const call = (client: Client, args?: Record<string, unknown>) => client.callTool({ name: 'fleet_email_outbox_await', arguments: args });

/** The real adapter through the real server, pointed at the temp runs dir. */
const realReader = (deps: FleetEmailOutboxAwaitDeps = {}): FleetReaders['emailOutboxAwait'] =>
  async (input, signal) => readFleetEmailOutboxAwait(input, signal, { runsDir: root, ...deps });
function saveConfig(config: Record<string, unknown>): void {
  mkdirSync(join(root, 'queue'), { recursive: true });
  writeFileSync(join(root, EMAIL_DROP_CONFIG_FILE), `${JSON.stringify(config)}\n`, { mode: 0o600 });
}
const writeReply = (dir: string, name: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), REPLY, { mode: 0o600 });
};
/** Saved config naming outboxDir plus the directory itself. */
const withOutbox = (from = 'owner@example.test'): string => {
  const outbox = join(root, 'outbox');
  saveConfig({ v: 1, inboxDir: join(root, 'inbox'), outboxDir: outbox, from: [from] });
  mkdirSync(outbox);
  return outbox;
};
/** Await seam with a manual clock; move runs between polls. */
const timedAwait = (now: () => number, sleep: (ms: number) => Promise<void>): typeof awaitEmailOutbox =>
  (opts) => awaitEmailOutbox({ ...opts, now, sleep });
const NAME = 'order-1.reply.eml';
const REPLY = 'To: Fake Owner <owner@private-marker.example>\r\nSubject: PRIVATE-MARKER-SUBJECT\r\n\r\nPRIVATE-MARKER-BODY\r\n';

/** Name+content digest over the whole runs root; proves read-only. */
const treeDigest = (): string => readdirSync(root, { recursive: true }).sort()
  .map(rel => { const p = join(root, rel); return lstatSync(p).isFile() ? `${rel}=${createHash('sha256').update(readFileSync(p)).digest('hex')}` : `${rel}/`; })
  .join('|');

describe('fleet_email_outbox_await over MCP', () => {
  it('is advertised read-only with a required name and bounded timeout/poll arguments', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_email_outbox_await');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toMatchObject({
      type: 'object', required: ['name', 'timeoutMs'], additionalProperties: false,
      properties: {
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS },
        pollMs: { type: 'integer', minimum: MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, maximum: MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, default: DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS },
      },
    });
  });

  it.each(['drafted', 'sent'] as const)('reports a queued artifact that lands in %s/ without leaking content', async (state) => {
    const outbox = withOutbox('owner@private-marker.example');
    writeReply(outbox, NAME);
    mkdirSync(join(outbox, state));
    let now = 0;
    const client = await connect({ emailOutboxAwait: realReader({
      await: timedAwait(() => now, async (ms) => {
        now += ms;
        if (existsSync(join(outbox, NAME))) renameSync(join(outbox, NAME), join(outbox, state, NAME));
      }),
    }) });
    const result = await call(client, { name: NAME, timeoutMs: 5000, pollMs: 100 });
    expect(parse(result)).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', sourceState: 'ok',
      name: NAME, state, reason: null, timedOut: false, cancelled: false,
    });
    const serialized = JSON.stringify(result);
    expect(result.isError).not.toBe(true);
    expect(serialized).not.toContain('PRIVATE-MARKER');
    expect(serialized).not.toContain('private-marker.example');
    expect(serialized).not.toContain(root);
    expect(readFileSync(join(outbox, state, NAME), 'utf8')).toBe(REPLY);
    expect(existsSync(join(outbox, NAME))).toBe(false);
  });

  it('times out for an artifact that never arrives', async () => {
    withOutbox();
    let now = 0;
    const client = await connect({ emailOutboxAwait: realReader({
      await: timedAwait(() => now, async (ms) => { now += ms; }),
    }) });
    const out = parse(await call(client, { name: NAME, timeoutMs: 300, pollMs: 100 }));
    expect(out).toMatchObject({ sourceState: 'ok', name: NAME, state: null, reason: null, timedOut: true, cancelled: false });
  });

  it('reports cancelled when the request signal aborts mid-wait', async () => {
    withOutbox();
    const controller = new AbortController();
    const out = await readFleetEmailOutboxAwait({ name: NAME, timeoutMs: 60_000 }, controller.signal, {
      runsDir: root,
      await: (opts: AwaitOptions) => awaitEmailOutbox({ ...opts, sleep: async () => { controller.abort(); } }),
    });
    expect(out).toMatchObject({ sourceState: 'ok', name: NAME, state: null, reason: null, timedOut: false, cancelled: true });
  });

  it('reports unobserved and skips the filesystem when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const readConfig = vi.fn();
    const out = await readFleetEmailOutboxAwait({ name: NAME, timeoutMs: 1000 }, controller.signal, { runsDir: root, readConfig });
    expect(out).toMatchObject({ sourceState: 'unobserved', name: NAME, state: null, reason: null, timedOut: false, cancelled: true });
    expect(readConfig).not.toHaveBeenCalled();
  });

  it('aborts the server-side wait when the client cancels the request', async () => {
    withOutbox();
    let observed: AbortSignal | undefined;
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const client = await connect({ emailOutboxAwait: async (input, signal) => {
      observed = signal;
      return readFleetEmailOutboxAwait(input, signal, {
        runsDir: root,
        await: (opts: AwaitOptions) => new Promise<AwaitResult>((resolve) => {
          started.resolve();
          opts.signal.addEventListener('abort', () => { aborted.resolve(); resolve({ name: opts.name, timedOut: false, cancelled: true }); }, { once: true });
        }),
      });
    } });
    const controller = new AbortController();
    const pending = client.callTool({ name: 'fleet_email_outbox_await', arguments: { name: NAME, timeoutMs: 300_000 } }, undefined, { signal: controller.signal });
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await aborted.promise;
    expect(observed?.aborted).toBe(true);
  });

  it('resolves the outbox solely from the saved config, including the inbox sibling fallback', async () => {
    const inbox = join(root, 'drop');
    const outbox = join(root, 'outbox');
    saveConfig({ v: 1, inboxDir: inbox, from: ['owner@example.test'] });
    mkdirSync(outbox);
    const seen: AwaitOptions[] = [];
    const client = await connect({ emailOutboxAwait: realReader({
      await: async (opts: AwaitOptions) => { seen.push(opts); return { name: opts.name, state: 'sent', timedOut: false, cancelled: false }; },
    }) });
    expect(parse(await call(client, { name: NAME, timeoutMs: 500 }))).toMatchObject({ sourceState: 'ok', name: NAME, state: 'sent' });
    expect(seen.map(opts => opts.dir)).toEqual([join(inbox, '..', 'outbox')]);
    expect(seen[0]).toMatchObject({ name: NAME, timeoutMs: 500, pollMs: DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['missing-config', () => { /* no config file at all */ }],
    ['invalid-config', () => saveConfig({ v: 2, inboxDir: 'relative', from: [] })],
    ['missing-outbox', (r: string) => saveConfig({ v: 1, inboxDir: join(r, 'inbox'), outboxDir: join(r, 'absent'), from: ['owner@example.test'] })],
    ['unreadable-outbox', (r: string) => {
      saveConfig({ v: 1, inboxDir: join(r, 'inbox'), outboxDir: join(r, 'afile'), from: ['owner@example.test'] });
      writeFileSync(join(r, 'afile'), 'not a directory');
    }],
  ])('reports %s distinctly and never invents a healthy observation', async (sourceState, arrange: (r: string) => void) => {
    arrange(root);
    const out = parse(await call(await connect({ emailOutboxAwait: realReader() }), { name: NAME, timeoutMs: 5000 }));
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      sourceState, name: NAME, state: null, reason: 'source-failure', timedOut: false, cancelled: false,
    });
  });

  it.each([
    {}, { timeoutMs: 500 }, { name: NAME },
    { name: 'x.eml', timeoutMs: 500 }, { name: 'x.reply.eml ', timeoutMs: 500 },
    { name: '../x.reply.eml', timeoutMs: 500 }, { name: 'a/x.reply.eml', timeoutMs: 500 },
    { name: NAME, timeoutMs: 0 }, { name: NAME, timeoutMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS + 1 },
    { name: NAME, timeoutMs: 1.5 }, { name: NAME, timeoutMs: '500' }, { name: NAME, timeoutMs: null },
    { name: NAME, timeoutMs: 500, pollMs: MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS - 1 },
    { name: NAME, timeoutMs: 500, pollMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS + 1 }, { name: NAME, timeoutMs: 500, pollMs: null },
    { name: NAME, timeoutMs: 500, dir: '/tmp/outbox' }, { name: NAME, timeoutMs: 500, root: '/tmp' },
    { name: NAME, timeoutMs: 500, cwd: '/tmp' }, { name: NAME, timeoutMs: 500, runsDir: '/tmp' },
    { name: NAME, timeoutMs: 500, send: true }, { name: NAME, timeoutMs: 500, x: 1 },
  ])('rejects arguments before invoking the reader: %j', async (args) => {
    const reader = vi.fn(async () => ({}));
    await expect(call(await connect({ emailOutboxAwait: reader }), args)).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('reports an interrupted claim as stuck and leaves every byte untouched (read-only, no transport)', async () => {
    const outbox = withOutbox();
    writeReply(outbox, 'queued.reply.eml');
    writeReply(join(outbox, 'sending'), NAME);
    const before = treeDigest();
    const out = parse(await call(await connect({ emailOutboxAwait: realReader() }), { name: NAME, timeoutMs: 5000 }));
    // A send pass would mkdir sent/ and claim files through sending/ — the tree must be identical.
    expect(out).toMatchObject({ sourceState: 'ok', name: NAME, state: 'stuck', reason: 'interrupted-send', timedOut: false, cancelled: false });
    expect(treeDigest()).toEqual(before);
  });

  it('keeps the fleet_email_outbox snapshot tool working alongside the await tool', async () => {
    const outbox = withOutbox();
    writeReply(outbox, NAME);
    const client = await connect({
      emailOutboxAwait: realReader(),
      emailOutbox: async (input) => readFleetEmailOutbox(input, { runsDir: root }),
    });
    const snap = parse(await client.callTool({ name: 'fleet_email_outbox' }));
    expect(snap).toMatchObject({ sourceState: 'ok', counts: { queued: 1, drafted: 0, sent: 0, stuck: 0 } });
    expect(snap.entries).toEqual([{ name: NAME, state: 'queued' }]);
  });

  it('parseFleetEmailOutboxAwaitArgs accepts only name and bounded timeoutMs/pollMs', () => {
    expect(parseFleetEmailOutboxAwaitArgs({ name: 'a.reply.eml', timeoutMs: 1 })).toEqual({ name: 'a.reply.eml', timeoutMs: 1 });
    expect(parseFleetEmailOutboxAwaitArgs({ name: 'A.REPLY.EML', timeoutMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS, pollMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS }))
      .toEqual({ name: 'A.REPLY.EML', timeoutMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS, pollMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS });
    for (const args of [
      {}, { name: 'a.reply.eml' }, { timeoutMs: 1 }, { name: '', timeoutMs: 1 }, { name: 'a.eml', timeoutMs: 1 },
      { name: '../a.reply.eml', timeoutMs: 1 }, { name: 'x/a.reply.eml', timeoutMs: 1 }, { name: 'a.reply.eml ', timeoutMs: 1 },
      { name: 1, timeoutMs: 1 }, { name: null, timeoutMs: 1 }, { name: 'a.reply.eml', timeoutMs: 0 },
      { name: 'a.reply.eml', timeoutMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS + 1 }, { name: 'a.reply.eml', timeoutMs: 1.5 },
      { name: 'a.reply.eml', timeoutMs: '1' }, { name: 'a.reply.eml', timeoutMs: null },
      { name: 'a.reply.eml', timeoutMs: 1, pollMs: MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS - 1 },
      { name: 'a.reply.eml', timeoutMs: 1, pollMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS + 1 }, { name: 'a.reply.eml', timeoutMs: 1, pollMs: null },
      { name: 'a.reply.eml', timeoutMs: 1, dir: '/tmp' }, { name: 'a.reply.eml', timeoutMs: 1, root: '/' },
      { name: 'a.reply.eml', timeoutMs: 1, cwd: '/tmp' }, { name: 'a.reply.eml', timeoutMs: 1, runsDir: '/tmp' },
      { name: 'a.reply.eml', timeoutMs: 1, send: true }, { name: 'a.reply.eml', timeoutMs: 1, x: 1 },
    ]) expect(parseFleetEmailOutboxAwaitArgs(args)).toBeNull();
  });
});
