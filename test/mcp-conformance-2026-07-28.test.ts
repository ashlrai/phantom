/**
 * Conformance: the phantom-served MCP surface against the 2026-07-28 profile.
 *
 * Covers the three legs named by RQ-PLAN-MCP0728-PHANTOM:
 *   - src/core/mcp-gateway.ts   (the `phm mcp` stdio aggregation server)
 *   - src/core/mcp-native.ts    (native ashlr_* tools served through it)
 *   - src/cli/mcp.ts            (run / list / doctor entry points)
 *
 * The 2026-07-28 profile this suite pins down (same profile as verse-mcp.ts):
 *   - `initialize` echoes a supported protocolVersion, including '2026-07-28';
 *     an unrecognized version is answered with the newest version served.
 *   - The stateless form: requests may skip `initialize` and carry their
 *     version in `params._meta` (protocolVersion or the namespaced
 *     io.modelcontextprotocol/protocolVersion spellings). Nothing here needs
 *     a prior initialize.
 *   - JSON-RPC 2.0 discipline: -32700 parse error, -32600 invalid request,
 *     -32601 method not found, -32602 invalid params; notifications and
 *     id-less requests are never answered; the reply id echoes the request id.
 *   - tools/list exposes name + inputSchema for every tool, namespaces
 *     downstream tools as `<server>__<tool>`, and passes spec-optional Tool
 *     fields (title, annotations, ...) through unchanged.
 *   - tools/call routes to the downstream child or the native registry and
 *     returns the {content:[{type:'text'}]} result shape.
 *
 * Wire checks run at two levels: an in-process InMemoryTransport pair bound to
 * the real SDK Server, and a spawned `tsx src/cli/index.ts mcp` child that
 * exercises real newline-delimited stdio, including malformed input.
 * test/fixtures/mock-mcp-server.mjs provides the downstream server throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  startGateway,
  GATEWAY_MCP_PROTOCOL_VERSIONS,
  negotiateGatewayProtocolVersion,
  gatewayInitializeResult,
} from '../src/core/mcp-gateway.js';
import type { McpRegistry } from '../src/core/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/mock-mcp-server.mjs', import.meta.url));
const NEWEST = '2026-07-28';

type Message = Record<string, unknown>;

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/**
 * Copy the mock server into a private dir: the argv-safety guard refuses
 * checkout paths whose folders contain secret-looking substrings, and a
 * private dir keeps the spec hermetic anyway.
 */
function fixtureSpec(name = 'mock'): { dir: string; spec: McpRegistry['servers'][number] } {
  const dir = tempDir('phm-mcp-conf-');
  const file = join(dir, 'server.mjs');
  copyFileSync(FIXTURE, file);
  return { dir, spec: { name, command: process.execPath, args: [file], source: 'test' } };
}

// ---------------------------------------------------------------------------
// Unit: version negotiation helpers
// ---------------------------------------------------------------------------

describe('GATEWAY_MCP_PROTOCOL_VERSIONS', () => {
  it('claims the 2026-07-28 profile as its newest version', () => {
    expect(GATEWAY_MCP_PROTOCOL_VERSIONS[0]).toBe(NEWEST);
  });

  it('keeps every version the SDK already supports', () => {
    for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']) {
      expect(GATEWAY_MCP_PROTOCOL_VERSIONS).toContain(v);
    }
  });
});

describe('negotiateGatewayProtocolVersion', () => {
  it('echoes every supported version', () => {
    for (const v of GATEWAY_MCP_PROTOCOL_VERSIONS) {
      expect(negotiateGatewayProtocolVersion(v)).toBe(v);
    }
  });

  it('answers an unrecognized or absent version with the newest served', () => {
    expect(negotiateGatewayProtocolVersion('2099-01-01')).toBe(NEWEST);
    expect(negotiateGatewayProtocolVersion('not-a-version')).toBe(NEWEST);
    expect(negotiateGatewayProtocolVersion(undefined)).toBe(NEWEST);
    expect(negotiateGatewayProtocolVersion(42)).toBe(NEWEST);
    expect(negotiateGatewayProtocolVersion(null)).toBe(NEWEST);
  });
});

describe('gatewayInitializeResult', () => {
  const caps = { tools: {}, resources: {} };
  const info = { name: 'ashlr', version: '9.9.9-test' };

  it('prefers params.protocolVersion over any _meta carrier', () => {
    const result = gatewayInitializeResult(
      { protocolVersion: '2024-11-05', _meta: { protocolVersion: NEWEST } }, caps, info);
    expect(result.protocolVersion).toBe('2024-11-05');
  });

  it('accepts every _meta spelling of the 2026-07-28 stateless form', () => {
    for (const key of ['protocolVersion', 'io.modelcontextprotocol/protocolVersion', 'modelcontextprotocol.io/protocolVersion']) {
      const result = gatewayInitializeResult({ _meta: { [key]: '2025-06-18' } }, caps, info);
      expect(result.protocolVersion).toBe('2025-06-18');
    }
  });

  it('negotiates the default for absent or malformed params', () => {
    for (const params of [undefined, null, {}, 'x', [], { protocolVersion: 7 }]) {
      expect(gatewayInitializeResult(params, caps, info).protocolVersion).toBe(NEWEST);
    }
  });

  it('returns the server capabilities and info verbatim', () => {
    const result = gatewayInitializeResult({ protocolVersion: NEWEST }, caps, info);
    expect(result.capabilities).toBe(caps);
    expect(result.serverInfo).toBe(info);
  });
});

// ---------------------------------------------------------------------------
// In-process wire conformance: real SDK Server + real fixture child
// ---------------------------------------------------------------------------

describe('gateway wire conformance (in-memory transport, real fixture child)', () => {
  let client: InMemoryTransport;
  let server: InMemoryTransport;
  let running: Promise<void>;
  let nextId = 1;
  let pending: Map<string | number, (m: Message) => void>;
  let unsolicited: Message[];
  let beforeSignals: Map<'SIGINT' | 'SIGTERM', Set<(...args: unknown[]) => void>>;

  function send(message: Message): void {
    void client.send(message).catch(() => {});
  }

  function request(method: string, params?: unknown, id?: string | number): Promise<Message> {
    const requestId = id ?? nextId++;
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`timed out waiting for reply to ${method} (id ${String(requestId)})`));
      }, 10_000);
      pending.set(requestId, (m) => { clearTimeout(timer); resolve(m); });
      send({ jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** Quiescence check: wait a beat, then assert nothing was answered. */
  async function expectSilence(ms = 60): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    expect(unsolicited).toEqual([]);
  }

  beforeEach(async () => {
    pending = new Map();
    unsolicited = [];
    nextId = 1;
    process.env['ASHLR_NO_HEAL'] = '1';
    beforeSignals = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal as 'SIGINT' | 'SIGTERM', new Set(process.listeners(signal))]));
    const { spec } = fixtureSpec();
    [client, server] = InMemoryTransport.createLinkedPair();
    client.onmessage = (m: Message) => {
      const id = m?.['id'];
      if ((typeof id === 'string' || typeof id === 'number') && pending.has(id)) {
        const resolve = pending.get(id)!;
        pending.delete(id);
        resolve(m);
      } else {
        unsolicited.push(m);
      }
    };
    running = startGateway({ servers: [spec] }, 4_000, server);
    // A completed ping proves connect() finished, so the transport onerror
    // hook is installed before tests poke it.
    await request('ping');
    unsolicited.length = 0;
  });

  afterEach(async () => {
    await client.close().catch(() => {});
    await running;
    for (const [signal, prior] of beforeSignals) for (const handler of process.listeners(signal)) {
      if (!prior.has(handler)) process.removeListener(signal, handler);
    }
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (process.env['ASHLR_NO_HEAL'] === '1') delete process.env['ASHLR_NO_HEAL'];
  });

  async function initialize(protocolVersion: string = NEWEST): Promise<Message> {
    const reply = await request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'conformance-test', version: '0.0.0' },
    });
    expect(reply['jsonrpc']).toBe('2.0');
    return reply;
  }

  describe('initialize negotiation', () => {
    it('echoes 2026-07-28 and advertises serverInfo + capabilities', async () => {
      const reply = await initialize(NEWEST);
      const result = reply['result'] as Message;
      expect(result['protocolVersion']).toBe(NEWEST);
      expect((result['serverInfo'] as Message)['name']).toBe('ashlr');
      expect(typeof (result['serverInfo'] as Message)['version']).toBe('string');
      expect((result['serverInfo'] as Message)['version']).not.toBe('');
      expect((result['capabilities'] as Message)['tools']).toBeDefined();
    });

    it('echoes older supported versions', async () => {
      for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
        const reply = await initialize(v);
        expect((reply['result'] as Message)['protocolVersion']).toBe(v);
      }
    });

    it('answers an unrecognized version with the newest served', async () => {
      const reply = await initialize('1999-01-01');
      expect((reply['result'] as Message)['protocolVersion']).toBe(NEWEST);
    });

    it('accepts the 2026-07-28 stateless spellings on initialize', async () => {
      let reply = await request('initialize', { _meta: { protocolVersion: NEWEST } });
      expect((reply['result'] as Message)['protocolVersion']).toBe(NEWEST);
      reply = await request('initialize', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-03-26' } });
      expect((reply['result'] as Message)['protocolVersion']).toBe('2025-03-26');
    });

    it('negotiates the default when initialize carries no params at all', async () => {
      const reply = await request('initialize');
      expect((reply['result'] as Message)['protocolVersion']).toBe(NEWEST);
    });
  });

  describe('stateless requests (no initialize)', () => {
    it('answers ping without a handshake', async () => {
      const reply = await request('ping');
      expect(reply['result']).toEqual({});
    });

    it('answers tools/list without a handshake', async () => {
      const reply = await request('tools/list');
      const tools = (reply['result'] as Message)['tools'] as Message[];
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.map((t) => t['name'])).toEqual(expect.arrayContaining(['mock__ping', 'mock__echo', 'ashlr_health']));
    });

    it('answers tools/call without a handshake', async () => {
      const reply = await request('tools/call', { name: 'mock__echo', arguments: { message: 'stateless' } });
      const content = (reply['result'] as Message)['content'] as Message[];
      expect(content[0]).toMatchObject({ type: 'text', text: 'stateless' });
    });
  });

  describe('tools/list shape', () => {
    it('gives every tool a name and an object inputSchema', async () => {
      const reply = await request('tools/list');
      const tools = (reply['result'] as Message)['tools'] as Message[];
      expect(tools.length).toBeGreaterThan(2);
      for (const tool of tools) {
        expect(typeof tool['name']).toBe('string');
        const schema = tool['inputSchema'] as Message;
        expect(schema).toBeDefined();
        expect(schema['type']).toBe('object');
      }
    });

    it('namespaces downstream tools and passes spec-optional fields through', async () => {
      const reply = await request('tools/list');
      const tools = (reply['result'] as Message)['tools'] as Message[];
      const ping = tools.find((t) => t['name'] === 'mock__ping')!;
      expect(ping['annotations']).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      const echo = tools.find((t) => t['name'] === 'mock__echo')!;
      expect(echo['title']).toBe('Echo');
      expect(echo['outputSchema']).toMatchObject({ type: 'object', required: ['text'] });
      expect(echo['icons']).toEqual([expect.objectContaining({ mimeType: 'image/svg+xml' })]);
      expect(echo['execution']).toMatchObject({ taskSupport: 'forbidden' });
      expect(echo['_meta']).toMatchObject({ 'mock.example/role': 'echo-fixture' });
      expect(String(echo['description'])).toContain('[mock]');
    });

    it('reports per-server discovery state in _meta', async () => {
      const reply = await request('tools/list');
      const meta = (reply['result'] as Message)['_meta'] as Message;
      const discovery = meta['ashlr/discovery'] as Message;
      const servers = discovery['servers'] as Message[];
      expect(servers).toEqual([expect.objectContaining({ name: 'mock', status: 'ready', lastKnownToolCount: 2 })]);
    });
  });

  describe('tools/call', () => {
    it('routes a namespaced call to the fixture and echoes the reply', async () => {
      const reply = await request('tools/call', { name: 'mock__ping' });
      const content = (reply['result'] as Message)['content'] as Message[];
      expect(content[0]).toMatchObject({ type: 'text', text: 'pong' });
    });

    it('serves a native ashlr tool with the standard content shape', async () => {
      const reply = await request('tools/call', { name: 'ashlr_health', arguments: {} });
      const result = reply['result'] as Message;
      expect(result['isError']).not.toBe(true);
      const content = result['content'] as Message[];
      expect(content[0]?.['type']).toBe('text');
      expect(() => JSON.parse(String(content[0]?.['text']))).not.toThrow();
    });

    it('rejects an unknown tool with -32602', async () => {
      const reply = await request('tools/call', { name: 'mock__nope' });
      const error = reply['error'] as Message;
      expect(error['code']).toBe(-32602);
      expect(String(error['message'])).toContain('Unknown tool');
    });

    it('rejects a bare downstream name with -32602 and a namespacing hint', async () => {
      const reply = await request('tools/call', { name: 'ping' });
      const error = reply['error'] as Message;
      expect(error['code']).toBe(-32602);
      expect(String(error['message'])).toContain('mock__ping');
    });

    it('rejects a call without a tool name with -32602', async () => {
      const reply = await request('tools/call', { arguments: {} });
      expect((reply['error'] as Message)['code']).toBe(-32602);
    });
  });

  describe('method discipline', () => {
    it('answers ping with an empty result', async () => {
      const reply = await request('ping');
      expect(reply['result']).toEqual({});
      expect(reply['error']).toBeUndefined();
    });

    it('answers unknown methods with -32601', async () => {
      for (const method of ['bogus/method', 'prompts/list', 'completion/complete', 'logging/setLevel']) {
        const reply = await request(method, method === 'logging/setLevel' ? { level: 'debug' } : {});
        expect((reply['error'] as Message)['code'], method).toBe(-32601);
      }
    });

    it('echoes string ids and keeps concurrent ids apart', async () => {
      const replies = await Promise.all([
        request('ping', {}, 'abc-1'),
        request('tools/call', { name: 'mock__echo', arguments: { message: 'first' } }, 'abc-2'),
        request('tools/call', { name: 'mock__echo', arguments: { message: 'second' } }, 7),
      ]);
      expect(replies[0]?.['id']).toBe('abc-1');
      expect(replies[1]?.['id']).toBe('abc-2');
      expect(((replies[1]?.['result'] as Message)['content'] as Message[])[0]?.['text']).toBe('first');
      expect(replies[2]?.['id']).toBe(7);
      expect(((replies[2]?.['result'] as Message)['content'] as Message[])[0]?.['text']).toBe('second');
    });

    it('never answers notifications or id-less requests', async () => {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99, reason: 'x' } });
      send({ jsonrpc: '2.0', method: 'notifications/bogus' });
      send({ jsonrpc: '2.0', method: 'tools/list' }); // id-less request = notification semantics
      await expectSilence();
      const reply = await request('ping');
      expect(reply['result']).toEqual({});
      expect(unsolicited).toEqual([]);
    });
  });

  describe('resources surface', () => {
    it('lists resources and resource templates with spec shapes', async () => {
      const list = await request('resources/list');
      expect(Array.isArray((list['result'] as Message)['resources'])).toBe(true);
      const templates = await request('resources/templates/list');
      expect(Array.isArray((templates['result'] as Message)['resourceTemplates'])).toBe(true);
    });

    it('answers an unknown resource URI with a result payload, not a crash', async () => {
      const reply = await request('resources/read', { uri: 'ashlr://bogus/nothing' });
      const contents = (reply['result'] as Message)['contents'] as Message[];
      expect(contents[0]?.['uri']).toBeDefined();
      const payload = JSON.parse(String(contents[0]?.['text'])) as Message;
      expect(payload['status']).toBe('unavailable');
    });
  });

  describe('transport-level error replies', () => {
    it('answers a JSON parse failure with -32700 and id null', async () => {
      server.onerror?.(new SyntaxError('Unexpected token } in JSON at position 3'));
      await vi.waitFor(() => expect(unsolicited.length).toBe(1));
      const reply = unsolicited[0]!;
      expect(reply['id']).toBeNull();
      expect((reply['error'] as Message)['code']).toBe(-32700);
    });

    it('answers a schema-invalid message with -32600 and id null', async () => {
      const zodLike = Object.assign(new Error('invalid message'), { issues: [{ code: 'invalid_type' }] });
      server.onerror?.(zodLike);
      await vi.waitFor(() => expect(unsolicited.length).toBe(1));
      const reply = unsolicited[0]!;
      expect(reply['id']).toBeNull();
      expect((reply['error'] as Message)['code']).toBe(-32600);
    });

    it('does not reply to internal transport errors', async () => {
      server.onerror?.(new Error('stdin exploded'));
      await expectSilence();
    });
  });
});

// ---------------------------------------------------------------------------
// Spawned conformance: real `phm mcp` over newline-delimited stdio
// ---------------------------------------------------------------------------

interface SpawnedWire {
  child: ChildProcess;
  inbox: Message[];
  stderr: () => string;
  sendLine: (obj: Message) => void;
  sendRaw: (line: string) => void;
  waitFor: (pred: (m: Message) => boolean, ms?: number) => Promise<Message>;
}

function spawnGatewayChild(home: string): SpawnedWire {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: dirname(process.execPath),
    ASHLR_NO_HEAL: '1',
    NO_COLOR: '1',
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('LOCUS_') || key === 'ASHLR_MCP_HOST') delete env[key];
  }
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'mcp'], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const inbox: Message[] = [];
  let stderrBuf = '';
  let stdoutBuf = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });
  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try { inbox.push(JSON.parse(line) as Message); } catch { inbox.push({ __unparsed: line }); }
    }
  });
  return {
    child,
    inbox,
    stderr: () => stderrBuf,
    sendLine: (obj) => child.stdin!.write(`${JSON.stringify(obj)}\n`),
    sendRaw: (line) => child.stdin!.write(`${line}\n`),
    waitFor: async (pred, ms = 25_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const found = inbox.find(pred);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for gateway reply; stderr:\n${stderrBuf}\ninbox:\n${JSON.stringify(inbox)}`);
    },
  };
}

describe('phm mcp wire conformance (spawned CLI)', () => {
  let home: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    home = tempDir('phm-mcp-home-');
    const { spec } = fixtureSpec();
    // Drop the fixture spec into the discovery path the CLI actually scans.
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { mock: { command: spec.command, args: spec.args } },
    }));
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve)).catch(() => {});
    }
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('serves the 2026-07-28 profile end to end over real stdio', async () => {
    const wire = spawnGatewayChild(home);
    children.push(wire.child);
    await vi.waitFor(() => expect(wire.stderr()).toContain('gateway ready'), { timeout: 30_000 });

    // Stateless form: no initialize, straight to tools/list.
    wire.sendLine({ jsonrpc: '2.0', id: 's1', method: 'tools/list' });
    const list = await wire.waitFor((m) => m['id'] === 's1');
    const names = ((list['result'] as Message)['tools'] as Message[]).map((t) => t['name']);
    expect(names).toEqual(expect.arrayContaining(['mock__ping', 'mock__echo']));

    // Handshake at the new version echoes the new version.
    wire.sendLine({ jsonrpc: '2.0', id: 's2', method: 'initialize', params: {
      protocolVersion: NEWEST, capabilities: {}, clientInfo: { name: 'wire-test', version: '0' },
    } });
    const init = await wire.waitFor((m) => m['id'] === 's2');
    expect((init['result'] as Message)['protocolVersion']).toBe(NEWEST);

    // A downstream call round-trips, then a notification draws no reply.
    wire.sendLine({ jsonrpc: '2.0', method: 'notifications/initialized' });
    wire.sendLine({ jsonrpc: '2.0', id: 's3', method: 'tools/call', params: { name: 'mock__echo', arguments: { message: 'wire' } } });
    const call = await wire.waitFor((m) => m['id'] === 's3');
    expect(((call['result'] as Message)['content'] as Message[])[0]).toMatchObject({ type: 'text', text: 'wire' });

    // Unknown method and both malformed-input classes.
    wire.sendLine({ jsonrpc: '2.0', id: 's4', method: 'bogus/method' });
    expect(((await wire.waitFor((m) => m['id'] === 's4'))['error'] as Message)['code']).toBe(-32601);
    wire.sendRaw('{this is not json');
    expect(((await wire.waitFor((m) => m['id'] === null && (m['error'] as Message)?.['code'] === -32700))['error'] as Message)['code']).toBe(-32700);
    wire.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 42 }));
    expect(((await wire.waitFor((m) => m['id'] === null && (m['error'] as Message)?.['code'] === -32600))['error'] as Message)['code']).toBe(-32600);

    // Clean shutdown on stdin close.
    wire.child.stdin!.end();
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);
      wire.child.once('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    expect(code).toBe(0);
  }, 60_000);

  it('phm mcp list --json reports discovered servers and native tools', async () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'mcp', 'list', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as Message;
    const servers = parsed['servers'] as Message[];
    expect(servers).toEqual([expect.objectContaining({ name: 'mock' })]);
    const native = parsed['native'] as Message[];
    expect(native.length).toBeGreaterThan(0);
    expect(native).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ashlr_health', safety: 'read' })]));
  }, 45_000);

  it('phm mcp doctor --json probes the fixture healthy', async () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'mcp', 'doctor', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 45_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    const healths = JSON.parse(result.stdout) as Message[];
    expect(healths).toEqual([expect.objectContaining({ name: 'mock', ok: true, toolCount: 2, tools: ['ping', 'echo'] })]);
  }, 60_000);
});
