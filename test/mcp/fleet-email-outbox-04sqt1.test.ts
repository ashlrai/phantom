/**
 * RQ-PHX-MCPEMAILOUTBOX04SQT1 — fleet_email_outbox: read-only metadata
 * evidence of the local email reply outbox through the isolated fleet MCP
 * server, so the Comms/leader agent can inspect the reply queue without
 * shell access or mail content.
 *
 * Hermetic: temp-dir runs roots, fake addresses, in-memory MCP transports
 * and injected readers; no daemon, transport, real mail or provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash } from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  DEFAULT_FLEET_EMAIL_OUTBOX_ENTRIES, MAX_FLEET_EMAIL_OUTBOX_ENTRIES,
  parseFleetEmailOutboxArgs, readFleetEmailOutbox, type FleetEmailOutboxArgs,
} from '../../src/mcp/fleet-email-outbox.js';
import { EMAIL_DROP_CONFIG_FILE } from '../../src/core/comms/email-drop-config.js';
import { EMAIL_OUTBOX_MAX_BYTES } from '../../src/core/comms/email-outbox.js';

const connections: Client[] = [];
let root: string;

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-email-outbox-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function connect(emailOutbox?: FleetReaders['emailOutbox']) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), emailOutbox });
  const client = new Client({ name: 'email-outbox-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

/** The real adapter through the real server, pointed at the temp runs dir. */
function realReader(spy?: (input: FleetEmailOutboxArgs) => void): FleetReaders['emailOutbox'] {
  return async (input) => { spy?.(input); return readFleetEmailOutbox(input, { runsDir: root }); };
}

function saveConfig(config: Record<string, unknown>): void {
  mkdirSync(join(root, 'queue'), { recursive: true });
  writeFileSync(join(root, EMAIL_DROP_CONFIG_FILE), `${JSON.stringify(config)}\n`, { mode: 0o600 });
}
function writeReply(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text, { mode: 0o600 });
}
const REPLY = 'To: Fake Owner <owner@example.test>\r\nSubject: PRIVATE-MARKER-SUBJECT\r\n\r\nPRIVATE-MARKER-BODY\r\n';
const DRAFT_REPLY = 'To: other@example.test\r\nSubject: drafted\r\n\r\nbody\r\n';

/** relpath → kind+content hash over the whole runs root; proves read-only. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const rel = path.slice(dir.length + 1);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out[rel] = `link:${readlinkSync(path)}`;
      else if (stat.isDirectory()) { out[`${rel}/`] = 'dir'; walk(path); }
      else out[rel] = `file:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

describe('fleet_email_outbox over MCP', () => {
  it('is advertised read-only with only a bounded limit argument', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_email_outbox');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_EMAIL_OUTBOX_ENTRIES, default: 50 } },
      additionalProperties: false,
    });
  });

  it('invokes the injected reader through the protocol with default and explicit limits', async () => {
    const reader = vi.fn(async (input: FleetEmailOutboxArgs) => ({ seen: input.limit }));
    const client = await connect(reader);
    expect(parse(await client.callTool({ name: 'fleet_email_outbox' }))).toEqual({ seen: DEFAULT_FLEET_EMAIL_OUTBOX_ENTRIES });
    expect(parse(await client.callTool({ name: 'fleet_email_outbox', arguments: { limit: 3 } }))).toEqual({ seen: 3 });
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('reports an available empty outbox without inventing entries', async () => {
    saveConfig({ v: 1, inboxDir: join(root, 'inbox'), outboxDir: join(root, 'outbox'), from: ['owner@example.test'] });
    mkdirSync(join(root, 'outbox'), { recursive: true });
    const client = await connect(realReader());
    const out = parse(await client.callTool({ name: 'fleet_email_outbox' }));
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', sourceState: 'ok',
      limit: DEFAULT_FLEET_EMAIL_OUTBOX_ENTRIES, configEnabled: true, sendReplies: false,
      counts: { queued: 0, drafted: 0, sent: 0, stuck: 0 }, total: 0, returned: 0, truncated: false, entries: [],
    });
  });

  it('reports queued/drafted/sent/stuck counts and stripped artifact rows', async () => {
    const outbox = join(root, 'outbox');
    // Config without outboxDir exercises the CLI's sibling-of-inboxDir derivation.
    saveConfig({ v: 1, inboxDir: join(root, 'drop'), from: ['owner@example.test'], sendReplies: true });
    writeReply(outbox, 'q1.reply.eml', REPLY);
    writeReply(join(outbox, 'sent'), 's1.reply.eml', REPLY);
    writeReply(join(outbox, 'sending'), 'c1.reply.eml', REPLY);
    writeReply(join(outbox, 'drafted'), 'd1.reply.eml', DRAFT_REPLY);
    writeReply(outbox, 'big.reply.eml', Buffer.alloc(EMAIL_OUTBOX_MAX_BYTES + 1, 0x61).toString('latin1'));
    symlinkSync('outside-target', join(outbox, 'sym.reply.eml'));
    const client = await connect(realReader());
    const out = parse(await client.callTool({ name: 'fleet_email_outbox' }));
    expect(out).toMatchObject({
      sourceState: 'ok', configEnabled: true, sendReplies: true,
      counts: { queued: 1, drafted: 1, sent: 1, stuck: 3 }, total: 6, returned: 6, truncated: false,
    });
    expect(out.entries).toEqual([
      { name: 'big.reply.eml', state: 'stuck', reason: 'oversized' },
      { name: 'q1.reply.eml', state: 'queued' },
      { name: 'sym.reply.eml', state: 'stuck', reason: 'symlink' },
      { name: 'c1.reply.eml', state: 'stuck', reason: 'interrupted-send' },
      { name: 's1.reply.eml', state: 'sent' },
      { name: 'd1.reply.eml', state: 'drafted' },
    ]);
  });

  it('clips the entry list at limit while counts and total cover the listing', async () => {
    const outbox = join(root, 'outbox');
    saveConfig({ v: 1, inboxDir: join(root, 'inbox'), outboxDir: outbox, from: ['owner@example.test'] });
    writeReply(outbox, 'a.reply.eml', REPLY);
    writeReply(outbox, 'b.reply.eml', REPLY);
    writeReply(join(outbox, 'sent'), 'c.reply.eml', REPLY);
    const client = await connect(realReader());
    const out = parse(await client.callTool({ name: 'fleet_email_outbox', arguments: { limit: 2 } }));
    expect(out).toMatchObject({
      sourceState: 'ok', counts: { queued: 2, drafted: 0, sent: 1, stuck: 0 },
      total: 3, returned: 2, truncated: true,
    });
    expect(out.entries).toHaveLength(2);
  });

  it.each([
    ['missing-config', () => { /* no config file at all */ }],
    ['invalid-config', () => saveConfig({ v: 2, inboxDir: 'relative', from: [] })],
    ['missing-outbox', (r: string) => saveConfig({ v: 1, inboxDir: join(r, 'inbox'), outboxDir: join(r, 'absent'), from: ['owner@example.test'] })],
    ['unreadable-outbox', (r: string) => {
      saveConfig({ v: 1, inboxDir: join(r, 'inbox'), outboxDir: join(r, 'afile'), from: ['owner@example.test'] });
      writeFileSync(join(r, 'afile'), 'not a directory');
    }],
  ])('reports %s distinctly and never invents a healthy empty outbox', async (sourceState, arrange) => {
    arrange(root);
    const client = await connect(realReader());
    const out = parse(await client.callTool({ name: 'fleet_email_outbox' }));
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      sourceState, counts: null, total: null, returned: null, truncated: null, entries: null,
    });
  });

  it.each([
    { dir: '/tmp/fake-outbox' }, { root: '/tmp' }, { cwd: '/tmp' }, { runsDir: '/tmp' }, { send: true },
    { limit: 0 }, { limit: MAX_FLEET_EMAIL_OUTBOX_ENTRIES + 1 }, { limit: 1.5 }, { limit: '5' }, { limit: null }, { x: 1 },
  ])('rejects arguments before invoking the reader: %j', async (args) => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_email_outbox', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('omits recipients, subjects, bodies and absolute paths from the serialized result', async () => {
    const outbox = join(root, 'outbox');
    saveConfig({ v: 1, inboxDir: join(root, 'inbox'), outboxDir: outbox, from: ['secret-human@private-marker.example'] });
    writeReply(outbox, 'q1.reply.eml', REPLY);
    const client = await connect(realReader());
    const result = await client.callTool({ name: 'fleet_email_outbox' });
    const serialized = JSON.stringify(result);
    expect(result.isError).not.toBe(true);
    expect(serialized).not.toContain('PRIVATE-MARKER');
    expect(serialized).not.toContain('private-marker.example');
    expect(serialized).not.toContain(root);
    const out = parse(result);
    for (const entry of out.entries as Array<Record<string, unknown>>) {
      expect(entry['name']).toBeTypeOf('string');
      expect(entry['state']).toBeTypeOf('string');
      expect(Object.keys(entry).every(k => ['name', 'state', 'reason'].includes(k))).toBe(true);
    }
  });

  it('leaves every artifact byte and name untouched (read-only)', async () => {
    const outbox = join(root, 'outbox');
    saveConfig({ v: 1, inboxDir: join(root, 'inbox'), outboxDir: outbox, from: ['owner@example.test'] });
    writeReply(outbox, 'q1.reply.eml', REPLY);
    writeReply(join(outbox, 'sent'), 's1.reply.eml', REPLY);
    writeReply(join(outbox, 'sending'), 'c1.reply.eml', REPLY);
    const before = snapshotTree(root);
    const client = await connect(realReader());
    const out = parse(await client.callTool({ name: 'fleet_email_outbox' }));
    expect(out.sourceState).toBe('ok');
    expect(snapshotTree(root)).toEqual(before);
  });

  it('returns a generic tool error when the reader itself throws', async () => {
    const client = await connect(async () => { throw new Error('private-source-value'); });
    const result = await client.callTool({ name: 'fleet_email_outbox' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-source-value');
  });

  it('parseFleetEmailOutboxArgs accepts only an optional bounded integer limit', () => {
    expect(parseFleetEmailOutboxArgs({})).toEqual({ limit: DEFAULT_FLEET_EMAIL_OUTBOX_ENTRIES });
    expect(parseFleetEmailOutboxArgs({ limit: 1 })).toEqual({ limit: 1 });
    expect(parseFleetEmailOutboxArgs({ limit: MAX_FLEET_EMAIL_OUTBOX_ENTRIES })).toEqual({ limit: MAX_FLEET_EMAIL_OUTBOX_ENTRIES });
    for (const args of [
      { limit: 0 }, { limit: MAX_FLEET_EMAIL_OUTBOX_ENTRIES + 1 }, { limit: null },
      { limit: 1.5 }, { limit: '3' }, { limit: true }, { x: 1 }, { dir: '/tmp/x' }, { send: true },
    ]) expect(parseFleetEmailOutboxArgs(args)).toBeNull();
  });
});
