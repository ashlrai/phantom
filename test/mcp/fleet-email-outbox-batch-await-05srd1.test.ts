/**
 * RQ-PHX-MCPEMAILBATCH05SRD1 — fleet_email_outbox_batch_await: a bounded wait
 * for up to 50 named reply artifacts to leave queued through the isolated
 * fleet MCP server, so a Comms agent blocks once per handoff instead of once
 * per email. Evidence only — drafted means drafted, never sent — and never
 * permission to send. Hermetic: temp roots, fake addresses, in-memory MCP.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  MAX_FLEET_EMAIL_OUTBOX_BATCH_AWAIT_NAMES, parseFleetEmailOutboxBatchAwaitArgs,
  readFleetEmailOutboxBatchAwait, type FleetEmailOutboxBatchAwaitDeps,
} from '../../src/mcp/fleet-email-outbox-batch-await.js';
import {
  DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS,
  MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS,
} from '../../src/mcp/fleet-email-outbox-await.js';
import { awaitEmailOutboxBatch, type BatchOptions, type BatchResult } from '../../src/core/comms/email-outbox-batch-await.js';
import { EMAIL_DROP_CONFIG_FILE } from '../../src/core/comms/email-drop-config.js';

const connections: Client[] = [];
let root: string;
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-email-outbox-batch-await-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function connect(readers: Pick<FleetReaders, 'emailOutboxBatchAwait'> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers });
  const client = new Client({ name: 'email-outbox-batch-await-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
const call = (client: Client, args?: Record<string, unknown>) => client.callTool({ name: 'fleet_email_outbox_batch_await', arguments: args });

/** The real adapter through the real server, pointed at the temp runs dir. */
const realReader = (deps: FleetEmailOutboxBatchAwaitDeps = {}): FleetReaders['emailOutboxBatchAwait'] =>
  async (input, signal) => readFleetEmailOutboxBatchAwait(input, signal, { runsDir: root, ...deps });
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
/** Batch-await seam with a manual clock; move runs between polls. */
const timedAwait = (now: () => number, sleep: (ms: number) => Promise<void>): typeof awaitEmailOutboxBatch =>
  (opts) => awaitEmailOutboxBatch({ ...opts, now, sleep });
const NAMES = ['order-1.reply.eml', 'order-2.reply.eml', 'order-3.reply.eml', 'order-4.reply.eml'];
const REPLY = 'To: Fake Owner <owner@private-marker.example>\r\nSubject: PRIVATE-MARKER-SUBJECT\r\n\r\nPRIVATE-MARKER-BODY\r\n';

/** Name+content digest over the whole runs root; proves read-only. */
const treeDigest = (): string => readdirSync(root, { recursive: true }).sort()
  .map(rel => { const p = join(root, rel); return lstatSync(p).isFile() ? `${rel}=${createHash('sha256').update(readFileSync(p)).digest('hex')}` : `${rel}/`; })
  .join('|');

describe('fleet_email_outbox_batch_await over MCP', () => {
  it('is advertised read-only with required distinct names and bounded timeout/poll arguments', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_email_outbox_batch_await');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toMatchObject({
      type: 'object', required: ['names', 'timeoutMs'], additionalProperties: false,
      properties: {
        names: { type: 'array', minItems: 1, maxItems: MAX_FLEET_EMAIL_OUTBOX_BATCH_AWAIT_NAMES, uniqueItems: true },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS },
        pollMs: { type: 'integer', minimum: MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, maximum: MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS, default: DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS },
      },
    });
  });

  it('reports a mixed batch (sent, drafted, stuck, malformed) in input order, read-only, no content leak', async () => {
    const outbox = withOutbox('owner@private-marker.example');
    writeReply(outbox, NAMES[0]!);
    writeReply(outbox, NAMES[1]!);
    writeReply(join(outbox, 'sending'), NAMES[2]!);
    writeReply(outbox, NAMES[3]!);
    writeReply(join(outbox, 'sent'), NAMES[3]!);
    mkdirSync(join(outbox, 'drafted'));
    let now = 0;
    const client = await connect({ emailOutboxBatchAwait: realReader({
      awaitBatch: timedAwait(() => now, async (ms) => {
        now += ms;
        if (existsSync(join(outbox, NAMES[0]!))) renameSync(join(outbox, NAMES[0]!), join(outbox, 'sent', NAMES[0]!));
        if (existsSync(join(outbox, NAMES[1]!))) renameSync(join(outbox, NAMES[1]!), join(outbox, 'drafted', NAMES[1]!));
      }),
    }) });
    const result = await call(client, { names: NAMES, timeoutMs: 5000, pollMs: 100 });
    expect(parse(result)).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', sourceState: 'ok',
      rows: [
        { name: NAMES[0], state: 'sent' }, { name: NAMES[1], state: 'drafted' },
        { name: NAMES[2], state: 'stuck', reason: 'interrupted-send' }, { name: NAMES[3], state: 'stuck', reason: 'malformed' },
      ],
      timedOut: false, cancelled: false, sourceFailure: false,
    });
    const serialized = JSON.stringify(result);
    expect(result.isError).not.toBe(true);
    expect(serialized).not.toContain('PRIVATE-MARKER');
    expect(serialized).not.toContain('private-marker.example');
    expect(serialized).not.toContain(root);
    expect(readFileSync(join(outbox, 'sent', NAMES[0]!), 'utf8')).toBe(REPLY);
    expect(readFileSync(join(outbox, 'drafted', NAMES[1]!), 'utf8')).toBe(REPLY);
  });

  it('times out with the last observed rows when an artifact never arrives (read-only, no transport)', async () => {
    const outbox = withOutbox();
    writeReply(outbox, NAMES[0]!);
    const before = treeDigest();
    let now = 0;
    const client = await connect({ emailOutboxBatchAwait: realReader({
      awaitBatch: timedAwait(() => now, async (ms) => { now += ms; }),
    }) });
    const out = parse(await call(client, { names: [NAMES[0], 'absent.reply.eml'], timeoutMs: 300, pollMs: 100 }));
    expect(out).toMatchObject({
      sourceState: 'ok', timedOut: true, cancelled: false, sourceFailure: false,
      rows: [{ name: NAMES[0], state: 'queued' }, { name: 'absent.reply.eml', state: 'missing' }],
    });
    expect(treeDigest()).toEqual(before);
  });

  it('reports cancelled when the request signal aborts mid-wait', async () => {
    withOutbox();
    const controller = new AbortController();
    const out = await readFleetEmailOutboxBatchAwait({ names: NAMES, timeoutMs: 60_000 }, controller.signal, {
      runsDir: root,
      awaitBatch: (opts: BatchOptions) => awaitEmailOutboxBatch({ ...opts, sleep: async () => { controller.abort(); } }),
    });
    expect(out).toMatchObject({ sourceState: 'ok', timedOut: false, cancelled: true, sourceFailure: false });
  });

  it('reports unobserved and skips the filesystem when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const readConfig = vi.fn();
    const out = await readFleetEmailOutboxBatchAwait({ names: NAMES, timeoutMs: 1000 }, controller.signal, { runsDir: root, readConfig });
    expect(out).toMatchObject({ sourceState: 'unobserved', rows: null, timedOut: false, cancelled: true, sourceFailure: false });
    expect(readConfig).not.toHaveBeenCalled();
  });

  it('aborts the server-side wait when the client cancels the request', async () => {
    withOutbox();
    let observed: AbortSignal | undefined;
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const client = await connect({ emailOutboxBatchAwait: async (input, signal) => {
      observed = signal;
      return readFleetEmailOutboxBatchAwait(input, signal, {
        runsDir: root,
        awaitBatch: (opts: BatchOptions) => new Promise<BatchResult>((resolve) => {
          started.resolve();
          opts.signal.addEventListener('abort', () => { aborted.resolve(); resolve({ rows: [], timedOut: false, cancelled: true, sourceFailure: false }); }, { once: true });
        }),
      });
    } });
    const controller = new AbortController();
    const pending = client.callTool({ name: 'fleet_email_outbox_batch_await', arguments: { names: NAMES, timeoutMs: 300_000 } }, undefined, { signal: controller.signal });
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
    const seen: BatchOptions[] = [];
    const client = await connect({ emailOutboxBatchAwait: realReader({
      awaitBatch: async (opts: BatchOptions) => { seen.push(opts); return { rows: [{ name: NAMES[0]!, state: 'sent' }], timedOut: false, cancelled: false, sourceFailure: false }; },
    }) });
    expect(parse(await call(client, { names: [NAMES[0]], timeoutMs: 500 }))).toMatchObject({ sourceState: 'ok', rows: [{ name: NAMES[0], state: 'sent' }] });
    expect(seen.map(opts => opts.dir)).toEqual([join(inbox, '..', 'outbox')]);
    expect(seen[0]).toMatchObject({ names: [NAMES[0]], timeoutMs: 500, pollMs: DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS });
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
  ])('reports %s distinctly with null rows and never invents a healthy batch', async (sourceState, arrange: (r: string) => void) => {
    arrange(root);
    const out = parse(await call(await connect({ emailOutboxBatchAwait: realReader() }), { names: NAMES, timeoutMs: 5000 }));
    expect(out).toMatchObject({ schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', sourceState, rows: null, timedOut: false, cancelled: false, sourceFailure: true });
  });

  it('reports sourceFailure with null rows when the outbox vanishes mid-wait', async () => {
    const outbox = withOutbox();
    writeReply(outbox, NAMES[0]!);
    let now = 0; let removed = false;
    const client = await connect({ emailOutboxBatchAwait: realReader({
      awaitBatch: timedAwait(() => now, async (ms) => {
        now += ms;
        if (!removed) { removed = true; rmSync(outbox, { recursive: true }); }
      }),
    }) });
    const out = parse(await call(client, { names: [NAMES[0]], timeoutMs: 5000, pollMs: 100 }));
    expect(out).toMatchObject({ sourceState: 'ok', rows: null, timedOut: false, cancelled: false, sourceFailure: true });
  });

  it.each([
    {}, { timeoutMs: 500 }, { names: NAMES }, { names: [], timeoutMs: 500 },
    { names: Array(MAX_FLEET_EMAIL_OUTBOX_BATCH_AWAIT_NAMES + 1).fill('a.reply.eml'), timeoutMs: 500 },
    { names: [NAMES[0], NAMES[0]], timeoutMs: 500 }, { names: null, timeoutMs: 500 }, { names: [1], timeoutMs: 500 },
    { names: ['x.eml'], timeoutMs: 500 }, { names: ['x.reply.eml '], timeoutMs: 500 }, { names: ['a\\b.reply.eml'], timeoutMs: 500 },
    { names: ['../x.reply.eml'], timeoutMs: 500 }, { names: ['a/x.reply.eml'], timeoutMs: 500 },
    { names: NAMES, timeoutMs: 0 }, { names: NAMES, timeoutMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS + 1 },
    { names: NAMES, timeoutMs: 1.5 }, { names: NAMES, timeoutMs: '500' }, { names: NAMES, timeoutMs: null },
    { names: NAMES, timeoutMs: 500, pollMs: MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS - 1 }, { names: NAMES, timeoutMs: 500, pollMs: null },
    { names: NAMES, timeoutMs: 500, pollMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS + 1 },
    { names: NAMES, timeoutMs: 500, dir: '/tmp/outbox' }, { names: NAMES, timeoutMs: 500, cwd: '/tmp' },
    { names: NAMES, timeoutMs: 500, runsDir: '/tmp' }, { names: NAMES, timeoutMs: 500, send: true }, { names: NAMES, timeoutMs: 500, x: 1 },
  ])('rejects arguments before invoking the reader: %j', async (args) => {
    const reader = vi.fn(async () => ({}));
    await expect(call(await connect({ emailOutboxBatchAwait: reader }), args)).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('parseFleetEmailOutboxBatchAwaitArgs accepts only distinct safe names and bounded timeoutMs/pollMs', () => {
    expect(parseFleetEmailOutboxBatchAwaitArgs({ names: ['a.reply.eml'], timeoutMs: 1 })).toEqual({ names: ['a.reply.eml'], timeoutMs: 1 });
    expect(parseFleetEmailOutboxBatchAwaitArgs({ names: ['A.REPLY.EML'], timeoutMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS, pollMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS }))
      .toEqual({ names: ['A.REPLY.EML'], timeoutMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS, pollMs: MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS });
    expect(parseFleetEmailOutboxBatchAwaitArgs({ names: Array.from({ length: 50 }, (_, i) => `${i}.reply.eml`), timeoutMs: 1 })?.names).toHaveLength(50);
    for (const args of [
      { names: [] }, { names: ['a.reply.eml', 'a.reply.eml'] }, { names: [1] }, { names: 'a.reply.eml' },
      { names: ['a.eml'] }, { names: ['../a.reply.eml'] }, { names: ['x/a.reply.eml'] }, { names: ['a.reply.eml '] },
      { names: Array.from({ length: 51 }, (_, i) => `${i}.reply.eml`) },
      { names: ['a.reply.eml'], timeoutMs: 0 }, { names: ['a.reply.eml'], timeoutMs: '1' }, { names: ['a.reply.eml'], timeoutMs: null },
      { names: ['a.reply.eml'], timeoutMs: 1, pollMs: null }, { names: ['a.reply.eml'], timeoutMs: 1, send: true },
      { names: ['a.reply.eml'], timeoutMs: 1, dir: '/tmp' }, { names: ['a.reply.eml'], timeoutMs: 1, runsDir: '/tmp' },
    ].map(bad => ({ timeoutMs: 1, ...bad }))) expect(parseFleetEmailOutboxBatchAwaitArgs(args)).toBeNull();
  });
});
