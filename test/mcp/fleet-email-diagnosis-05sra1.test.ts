/**
 * RQ-PHX-MCPEMAILDIAGNOSIS05SRA1 — fleet_email_diagnosis: read-only fixed-code
 * diagnosis of why local email replies are not flowing, through the isolated
 * fleet MCP server, so a Comms agent can answer without a shell or mail
 * access. The tool delegates to the shared diagnoseEmailDrop backend at the
 * server-owned runs dir — never a second classifier.
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
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  parseFleetEmailDiagnosisArgs, readFleetEmailDiagnosis, type FleetEmailDiagnosisDeps,
} from '../../src/mcp/fleet-email-diagnosis.js';
import { EMAIL_DROP_CONFIG_FILE } from '../../src/core/comms/email-drop-config.js';
import type { EmailDiagnosis } from '../../src/core/comms/email-diagnosis.js';

const connections: Client[] = [];
let root: string;

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-email-diagnosis-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function connect(emailDiagnosis?: FleetReaders['emailDiagnosis']) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), emailDiagnosis });
  const client = new Client({ name: 'email-diagnosis-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

/** The real adapter through the real server, pointed at the temp runs dir. */
function realReader(deps: FleetEmailDiagnosisDeps = {}): FleetReaders['emailDiagnosis'] {
  return async () => readFleetEmailDiagnosis({ runsDir: root, ...deps });
}

function saveConfig(config: Record<string, unknown>): void {
  mkdirSync(join(root, 'queue'), { recursive: true });
  writeFileSync(join(root, EMAIL_DROP_CONFIG_FILE), `${JSON.stringify(config)}\n`, { mode: 0o600 });
}
const REPLY = 'To: Fake Owner <owner@example.test>\r\nSubject: PRIVATE-MARKER-SUBJECT\r\n\r\nPRIVATE-MARKER-BODY\r\n';
function writeReply(dir: string, name: string, text = REPLY): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text, { mode: 0o600 });
}
const COVERAGE = 'local-evidence-only-not-gmail-triage-or-proof-of-delivery';

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

describe('fleet_email_diagnosis over MCP', () => {
  it('is advertised read-only with an empty argument object', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_email_diagnosis');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('invokes the injected reader through the protocol', async () => {
    const reader = vi.fn(async () => ({ seen: true }));
    const client = await connect(reader);
    expect(parse(await client.callTool({ name: 'fleet_email_diagnosis' }))).toEqual({ seen: true });
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing config', () => { /* no config file at all */ },
      { config: 'missing', polling: 'unknown', sendReplies: 'unknown', outbox: 'not-established', counts: null, replies: 'not-configured' }],
    ['invalid config', () => saveConfig({ v: 2, inboxDir: 'relative', from: [] }),
      { config: 'invalid', polling: 'unknown', sendReplies: 'unknown', outbox: 'not-established', counts: null, replies: 'not-configured' }],
    ['paused polling', (r: string) => {
      saveConfig({ v: 1, enabled: false, inboxDir: join(r, 'inbox'), outboxDir: join(r, 'outbox'), from: ['owner@example.test'] });
      mkdirSync(join(r, 'outbox'), { recursive: true });
    }, { config: 'ok', polling: 'paused', replies: 'paused' }],
    ['draft-only replies', (r: string) => {
      saveConfig({ v: 1, inboxDir: join(r, 'inbox'), outboxDir: join(r, 'outbox'), from: ['owner@example.test'] });
      writeReply(join(r, 'outbox'), 'held.reply.eml');
    }, { config: 'ok', polling: 'enabled', sendReplies: 'disabled', replies: 'draft-only',
      counts: { queued: 1, drafted: 0, sent: 0, stuck: 0 } }],
    ['a blocked outbox', (r: string) => {
      saveConfig({ v: 1, inboxDir: join(r, 'inbox'), outboxDir: join(r, 'outbox'), from: ['owner@example.test'], sendReplies: true });
      writeReply(join(r, 'outbox', 'sending'), 'orphan.reply.eml');
    }, { config: 'ok', sendReplies: 'enabled', outbox: 'ok', replies: 'blocked',
      counts: { queued: 0, drafted: 0, sent: 0, stuck: 1 } }],
    ['send-enabled replies', (r: string) => {
      saveConfig({ v: 1, inboxDir: join(r, 'inbox'), outboxDir: join(r, 'outbox'), from: ['owner@example.test'], sendReplies: true });
      mkdirSync(join(r, 'outbox'), { recursive: true });
    }, { config: 'ok', polling: 'enabled', sendReplies: 'enabled', outbox: 'ok', replies: 'send-enabled',
      counts: { queued: 0, drafted: 0, sent: 0, stuck: 0 } }],
  ])('reports %s through the shared backend without duplicating it', async (_label, arrange, diagnosis) => {
    arrange(root);
    const client = await connect(realReader());
    const out = parse(await client.callTool({ name: 'fleet_email_diagnosis' }));
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', sourceState: 'ok', coverage: COVERAGE,
    });
    expect(out.diagnosis).toMatchObject({ ...diagnosis, coverage: COVERAGE });
    for (const check of out.diagnosis.checks as Array<Record<string, unknown>>) {
      expect(Object.keys(check)).toEqual(['id', 'state', 'reason', 'nextStep']);
      for (const value of Object.values(check)) expect(value).toBeTypeOf('string');
    }
  });

  it.each([
    { dir: '/tmp/fake-outbox' }, { root: '/tmp' }, { cwd: '/tmp' }, { path: '/tmp' }, { runsDir: '/tmp' },
    { send: true }, { sendReplies: true }, { confirmedByMason: true }, { limit: 5 }, { x: 1 },
  ])('rejects arguments before invoking the reader: %j', async (args) => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_email_diagnosis', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('reports a throwing collector as fixed unavailable evidence, never healthy counts', async () => {
    const client = await connect(realReader({
      diagnose: async () => { throw new Error('private-collector-detail'); },
    }));
    const result = await client.callTool({ name: 'fleet_email_diagnosis' });
    expect(result.isError).not.toBe(true);
    expect(parse(result)).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      sourceState: 'unavailable', coverage: COVERAGE, diagnosis: null,
    });
    expect(JSON.stringify(result)).not.toContain('private-collector-detail');
  });

  it('omits addresses, subjects, bodies and absolute paths from the serialized result', async () => {
    saveConfig({ v: 1, inboxDir: join(root, 'inbox'), outboxDir: join(root, 'outbox'), from: ['secret-human@private-marker.example'], sendReplies: true });
    writeReply(join(root, 'outbox'), 'q1.reply.eml');
    const client = await connect(realReader());
    const result = await client.callTool({ name: 'fleet_email_diagnosis' });
    const serialized = JSON.stringify(result);
    expect(result.isError).not.toBe(true);
    for (const marker of ['PRIVATE-MARKER', 'private-marker.example', 'secret-human', root, 'q1.reply.eml']) {
      expect(serialized).not.toContain(marker);
    }
    const out = parse(result);
    expect(out.diagnosis).toMatchObject({ config: 'ok', replies: 'send-enabled', counts: { queued: 1, drafted: 0, sent: 0, stuck: 0 } });
  });

  it('leaves config bytes and every artifact untouched (read-only)', async () => {
    saveConfig({ v: 1, inboxDir: join(root, 'inbox'), outboxDir: join(root, 'outbox'), from: ['owner@example.test'], sendReplies: true });
    writeReply(join(root, 'outbox'), 'q1.reply.eml');
    writeReply(join(root, 'outbox', 'sending'), 'stuck.reply.eml');
    const before = snapshotTree(root);
    const client = await connect(realReader());
    const out = parse(await client.callTool({ name: 'fleet_email_diagnosis' }));
    expect(out.sourceState).toBe('ok');
    expect(out.diagnosis).toMatchObject({ sendReplies: 'enabled', replies: 'blocked' });
    expect(snapshotTree(root)).toEqual(before);
  });

  it('returns a generic tool error when the reader itself throws', async () => {
    const client = await connect(async () => { throw new Error('private-source-value'); });
    const result = await client.callTool({ name: 'fleet_email_diagnosis' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-source-value');
  });

  it('passes the diagnosis through verbatim from the injected collector', async () => {
    const seen: string[] = [];
    const fake: EmailDiagnosis = {
      config: 'ok', polling: 'enabled', sendReplies: 'disabled', outbox: 'ok',
      counts: { queued: 3, drafted: 1, sent: 0, stuck: 0 }, replies: 'draft-only', coverage: COVERAGE,
      checks: [{ id: 'email-send', state: 'unsupported', reason: 'send-replies-disabled-draft-only', nextStep: 'phm comms setup-email' }],
    };
    const client = await connect(realReader({
      diagnose: async (runsDir) => { seen.push(runsDir); return fake; },
    }));
    const out = parse(await client.callTool({ name: 'fleet_email_diagnosis' }));
    expect(seen).toEqual([root]);
    expect(out).toMatchObject({ sourceState: 'ok', coverage: COVERAGE });
    expect(out.diagnosis).toEqual(fake);
  });

  it('parseFleetEmailDiagnosisArgs accepts only the empty object', () => {
    expect(parseFleetEmailDiagnosisArgs({})).toEqual({});
    for (const args of [
      { x: 1 }, { dir: '/tmp/x' }, { runsDir: '/tmp' }, { send: true }, { limit: null }, { limit: 1 },
    ]) expect(parseFleetEmailDiagnosisArgs(args)).toBeNull();
  });
});
