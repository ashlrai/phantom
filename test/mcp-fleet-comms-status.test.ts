/**
 * fleet_comms_status: the owner comms status over the isolated fleet MCP
 * server — the same readOwnerCommsStatus projection `phm comms status
 * --json`, the native `ashlr_comms` tool and the owner-thread API serve.
 * fleet_comms_inbox lists the pending owner items; this is the operational
 * rollup behind them — kill/pause verdicts, awaiting/undelivered counts,
 * the per-channel adapter states and the teammate reply gap — with no
 * arguments accepted and unknown-stays-unknown honesty passed through
 * untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, and crafted
 * owner-thread fixtures under temp runs dirs — never the real home,
 * config, owner thread or pause/kill stores.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetCommsStatusArgs, readFleetCommsStatus } from '../src/mcp/fleet-comms-status.js';
import { readOwnerCommsStatus, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { emptyOwnerSettings, type OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import type { OwnerCommsStatus } from '../src/core/comms/owner-thread.js';

const connections: Client[] = [];
const roots: string[] = [];
const TOOL = 'fleet_comms_status';

afterEach(() => {
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

const settings: OwnerThreadSettings = {
  owners: {
    desktop: 'local-owner', telegram: 'telegram:100', email: 'email:owner@example.com',
    imessage: 'owner@example.com', slack: 'U0123456789',
  },
  secretHandles: { telegram: 'phm_TELEGRAM_BOT_TOKEN', email: 'phm_EMAIL_CREDENTIAL', slack: 'phm_SLACK_BOT_TOKEN' },
  imessageBridge: 'loopback',
  confirmed: true,
  team: [
    { channel: 'bus', id: 'local-owner' },
    { channel: 'telegram', id: 'telegram:100' },
    { channel: 'email', id: 'email:owner@example.com' },
    { channel: 'imessage', id: 'owner@example.com' },
    { channel: 'slack', id: 'U0123456789' },
  ],
};

const status = (over: Partial<OwnerCommsStatus> = {}): OwnerCommsStatus => ({
  schema: 'comms.owner-thread.status.v1',
  claimKey: 'queue:RQ-COMMS-UNIFIED-1',
  threadId: 'owner',
  kill: false,
  paused: false,
  messages: 4,
  awaitingReply: 1,
  undeliveredReplies: 0,
  adapters: [{
    id: 'desktop', configured: true, enabled: true, halted: false,
    secretHandle: null, reason: 'Native desktop thread is configured.', nextStep: null,
  }],
  replyGap: [{
    teammate: 'Teammate', lastInboundAt: null, lastOutboundAt: null,
    unansweredCount: 0, oldestUnansweredMs: 0, state: 'unknown',
  }],
  ...over,
});

/** A temp runs dir; `corrupt` writes an unreadable owner-thread record. */
function runsDir(corrupt = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-comms-status-'));
  roots.push(dir);
  const leader = join(dir, 'leader');
  mkdirSync(leader, { recursive: true });
  if (corrupt) writeFileSync(join(leader, 'owner-thread.json'), '{not json');
  return dir;
}

function ownerOptions(dir: string, over: Partial<OwnerThreadOptions> = {}): OwnerThreadOptions {
  return {
    runsDir: dir,
    settings,
    now: () => 1_700_000_000_000,
    halted: false,
    paused: false,
    ...over,
  };
}

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra });
  const client = new Client({ name: 'comms-status-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: TOOL, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_comms_status argument parsing', () => {
  it('accepts only an empty argument object — every store root stays server-owned', () => {
    expect(parseFleetCommsStatusArgs({})).toEqual({});
  });

  it('rejects every key before any read runs', () => {
    for (const bad of [
      { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { home: '/tmp' },
      { runsDir: '/tmp/x' }, { configDir: '/tmp/x' }, { limit: 1 }, { extra: 1 }, { json: true },
    ]) expect(parseFleetCommsStatusArgs(bad)).toBeNull();
  });
});

describe('fleet_comms_status reader', () => {
  it('spreads the shared projection beside the envelope metadata', async () => {
    const seen: unknown[][] = [];
    const read = async () => {
      seen.push([]);
      return status();
    };
    const result = await readFleetCommsStatus({ status: read });
    expect(seen).toEqual([[]]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      schema: 'comms.owner-thread.status.v1',
      claimKey: 'queue:RQ-COMMS-UNIFIED-1', threadId: 'owner',
      kill: false, paused: false,
      messages: 4, awaitingReply: 1, undeliveredReplies: 0,
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const adapters = (result as OwnerCommsStatus).adapters;
    expect(adapters[0]).toMatchObject({ id: 'desktop', enabled: true });
  });

  it('reports an unreadable status as unavailable — never an invented healthy rollup', async () => {
    const result = await readFleetCommsStatus({
      status: async () => { throw new Error('owner config store unreadable'); },
    });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'unavailable', reason: 'owner-comms-status-unreadable',
    });
    expect('adapters' in result).toBe(false);
    expect('awaitingReply' in result).toBe(false);
  });

  it('serves the real readOwnerCommsStatus projection from a crafted thread, read-only', async () => {
    const dir = runsDir();
    const leader = join(dir, 'leader');
    mkdirSync(leader, { recursive: true });
    writeFileSync(join(leader, 'owner-thread.json'), JSON.stringify({
      v: 1, threadId: 'owner', deliveries: {},
      messages: [{
        seq: 1, id: 'm1', idempotencyKey: 'inbound-key-1', channel: 'desktop',
        senderId: 'local-owner', direction: 'inbound',
        at: '2026-11-18T10:00:00.000Z', text: 'status check',
      }],
    }));
    const result = await readFleetCommsStatus({ status: () => readOwnerCommsStatus(ownerOptions(dir)) });
    const report = result as OwnerCommsStatus;
    expect(report.schema).toBe('comms.owner-thread.status.v1');
    expect(report.claimKey).toBe('queue:RQ-COMMS-UNIFIED-1');
    expect(report.messages).toBe(1);
    // One live inbound no recorded outbound cites: the awaiting mark is real.
    expect(report.awaitingReply).toBe(1);
    expect(report.undeliveredReplies).toBe(0);
    // Every configured channel reports enabled under the crafted settings;
    // secret handles surface as names only, never values.
    expect(report.adapters.map(adapter => adapter.id)).toEqual(['desktop', 'telegram', 'email', 'imessage', 'slack']);
    expect(report.adapters.every(adapter => adapter.enabled)).toBe(true);
    expect(report.adapters.find(adapter => adapter.id === 'telegram')?.secretHandle).toBe('phm_TELEGRAM_BOT_TOKEN');
    // No teammate evidence under the temp runs dir: the gap read is unknown, never ok.
    expect(report.replyGap).toEqual([expect.objectContaining({ teammate: 'Teammates', state: 'unknown' })]);
  });

  it('keeps counts null when the thread cannot be read — unknown stays unknown, never 0', async () => {
    const dir = runsDir(true);
    const result = await readFleetCommsStatus({ status: () => readOwnerCommsStatus(ownerOptions(dir)) });
    const report = result as OwnerCommsStatus;
    expect(report.schema).toBe('comms.owner-thread.status.v1');
    expect(report.messages).toBeNull();
    expect(report.awaitingReply).toBeNull();
    expect(report.undeliveredReplies).toBeNull();
    // Adapter states still answer from settings alone.
    expect(report.adapters).toHaveLength(5);
  });

  it('reports disabled adapters honestly with empty settings', async () => {
    const dir = runsDir();
    const result = await readFleetCommsStatus({
      status: () => readOwnerCommsStatus(ownerOptions(dir, { settings: emptyOwnerSettings() })),
    });
    const report = result as OwnerCommsStatus;
    expect(report.adapters.every(adapter => !adapter.configured && !adapter.enabled)).toBe(true);
    expect(report.adapters.every(adapter => adapter.nextStep !== null)).toBe(true);
  });
});

describe('fleet_comms_status MCP tool', () => {
  it('is advertised read-only with an empty argument schema beside fleet_comms_inbox', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === TOOL);
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('readOwnerCommsStatus');
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }],
    [{ home: '/tmp' }], [{ runsDir: '/tmp/x' }], [{ limit: 5 }], [{ extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const commsStatus = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), commsStatus });
    await expect(client.callTool({ name: TOOL, arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(commsStatus).not.toHaveBeenCalled();
  });

  it('calls the injected reader with no arguments and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z', ...status(),
    };
    const commsStatus = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), commsStatus });
    const { parsed } = await call(client, {});
    expect(commsStatus).toHaveBeenCalledWith();
    expect(parsed).toEqual(payload);
    expect(parsed.awaitingReply).toBe(1);
  });

  it('accepts an omitted arguments object', async () => {
    const commsStatus = vi.fn(async () => ({ ok: true }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), commsStatus });
    const { parsed } = await call(client);
    expect(commsStatus).toHaveBeenCalledWith();
    expect(parsed).toEqual({ ok: true });
  });

  it('keeps a throwing injected reader behind the sanitized fleet error', async () => {
    const client = await connect({
      status: async () => ({}), loop: async () => ({}),
      commsStatus: async () => { throw new Error('secret-shaped detail'); },
    });
    const result = await client.callTool({ name: TOOL, arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]!.text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
  });

  it('documents the tool in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_comms_status` \|/m);
  });
});
