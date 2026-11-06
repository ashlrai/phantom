import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, isNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import * as bus from '../src/core/fleet/bus-inbox.js';

const gate = vi.hoisted(() => ({ killed: false, audit: vi.fn() }));
vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/sandbox/audit.js', () => ({ audit: gate.audit }));
vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => gate.killed }));

let root: string;
let now: number;
const original = { append: bus.appendBusInbox, read: bus.listBusInboxAfter, status: bus.inspectBusInbox };
const message = (id = 'fake-1', ttl = 100) => ({
  id, from: 'fake-sender', to: 'fake-recipient', priority: 'P2', ttl, body: { text: 'fake message' },
});
const options = () => ({ root, now: () => now });
const call = async (name: string, args: unknown = {}) => {
  const result = await callNativeTool(`phantom_agent_bus_${name}`, args);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fake-native-bus-'));
  now = 100;
  gate.killed = false;
  vi.spyOn(bus, 'appendBusInbox').mockImplementation(input => original.append(input, options()));
  vi.spyOn(bus, 'listBusInboxAfter').mockImplementation((after, limit) => original.read(after, limit, options()));
  vi.spyOn(bus, 'inspectBusInbox').mockImplementation(() => original.status(options()));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('native MCP durable agent bus', () => {
  it('registers discoverable tools with their safety classifications and schemas', () => {
    for (const [suffix, safety] of [['read', 'read'], ['status', 'read'], ['post', 'append']] as const) {
      const name = `phantom_agent_bus_${suffix}`;
      expect(isNativeTool(name)).toBe(true);
      expect(nativeToolSafety(name)).toBe(safety);
      expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    const schema = listNativeTools().find(tool => tool.name === 'phantom_agent_bus_read')?.inputSchema;
    expect(schema).toMatchObject({ properties: { after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: { minimum: 1, maximum: 100 } } });
  });

  it('posts to the same store used by bus readers and reports duplicate, conflict and capacity', async () => {
    expect(await call('status')).toMatchObject({ source: 'missing', retainedCount: null });
    expect(await call('post', message())).toEqual({ status: 'posted', id: 'fake-1', cursor: 1 });
    expect(original.read(0, 50, options())).toMatchObject({ status: 'ok', messages: [{ envelope: message() }] });
    expect(await call('post', message())).toEqual({ status: 'duplicate', id: 'fake-1', cursor: 1 });
    expect(await call('post', { ...message(), body: 'fake conflict' })).toEqual({ status: 'conflict' });
    expect(await call('status')).toMatchObject({ source: 'available', retainedCount: 1, liveCount: 1, expiredCount: 0 });
    expect(await call('read')).toMatchObject({ status: 'ok', nextCursor: 1, messages: [{ cursor: 1, envelope: message() }] });
  });

  it('resumes after expired rows and decreases the remaining TTL', async () => {
    await call('post', message('fake-expiring', 10));
    await call('post', message('fake-live', 100));
    await call('post', message('fake-next', 100));
    now = 110;
    const first = await call('read', { after: 0, limit: 1 });
    expect(first).toMatchObject({ status: 'ok', nextCursor: 2, messages: [{ cursor: 2, envelope: { id: 'fake-live', ttl: 90 } }] });
    expect(await call('read', { after: first.nextCursor, limit: 1 })).toMatchObject({ nextCursor: 3, messages: [{ cursor: 3 }] });
    expect(await call('status')).toMatchObject({ retainedCount: 3, liveCount: 2, expiredCount: 1 });
    now = 200;
    expect(await call('read', { after: 0 })).toMatchObject({ messages: [], nextCursor: 3 });
  });

  it('rejects malformed inputs before the append API is called', async () => {
    const badPosts: unknown[] = [null, {}, { ...message(), extra: true }, { ...message(), ttl: 0 }, { ...message(), priority: 'fake' }, { ...message(), body: undefined }];
    for (const input of badPosts) expect((await callNativeTool('phantom_agent_bus_post', input)).isError).toBe(true);
    for (const input of [{ after: -1 }, { after: Number.MAX_SAFE_INTEGER + 1 }, { after: 0.5 }, { limit: 0 }, { limit: 101 }, { limit: null }, { extra: true }]) {
      expect((await callNativeTool('phantom_agent_bus_read', input)).isError).toBe(true);
    }
    expect((await callNativeTool('phantom_agent_bus_status', { extra: true })).isError).toBe(true);
    expect(bus.appendBusInbox).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
    expect(await call('post', { ...message(), body: null })).toMatchObject({ status: 'posted' });
  });

  it('enforces the existing KILL gate for appends while permitting reads', async () => {
    gate.killed = true;
    expect((await callNativeTool('phantom_agent_bus_post', message())).isError).toBe(true);
    expect(bus.appendBusInbox).not.toHaveBeenCalled();
    expect(await call('read')).toMatchObject({ status: 'ok', messages: [] });
    expect(await call('status')).toMatchObject({ source: 'missing' });
    expect(gate.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mcp:native-call', result: 'refused' }));
  });

  it('scrubs returned data and audits argument keys without recording values', async () => {
    const fakeSecret = 'ghp_' + 'A1b2C3d4'.repeat(5);
    await call('post', { ...message(), body: { text: fakeSecret } });
    const result = await callNativeTool('phantom_agent_bus_read', {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).not.toContain(fakeSecret);
    expect(JSON.stringify(gate.audit.mock.calls)).not.toContain(fakeSecret);
  });
});
