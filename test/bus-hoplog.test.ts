import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  statSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendBusHop, BUS_HOPLOG_MAX_BYTES, busHoplogPath, busMessageIds, createBusHop,
} from '../src/core/fleet/bus-hoplog.js';

let root: string, file: string;
const ids = { id: 'message-1', from: 'codex-cmp', to: 'RQ-EVENTD' };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bus-hoplog-'));
  file = join(root, 'bus', 'hops.jsonl');
  vi.stubEnv('ASHLR_HOME', root);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('metadata-only bus hop log', () => {
  it('never contains body text, nested bodies, extra fields or serialization hooks', () => {
    const bodyText = 'PRIVATE-BODY-MUST-NEVER-REACH-HOPLOG';
    const body = vi.fn(() => { throw new Error(bodyText); });
    const toJSON = vi.fn(() => ({ body: bodyText }));
    const envelope = {
      ...ids, priority: 'P0', ttl: 1000, inputTokens: 12, outputTokens: 0,
      nested: { body: bodyText }, toJSON,
      get body() { return body(); },
    };
    expect(appendBusHop(envelope, file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text.includes(bodyText)).toBe(false);
    expect(JSON.parse(text)).toEqual({ ...ids, inputTokens: 12, outputTokens: 0 });
    expect(body).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('records absent usage as unknown and appends separate hops without overwriting', () => {
    expect(appendBusHop(ids, file)).toBe(true);
    expect(appendBusHop({ ...ids, id: 'message-2', outputTokens: 42 }, file)).toBe(true);
    expect(readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { ...ids, inputTokens: null, outputTokens: null },
      { ...ids, id: 'message-2', inputTokens: null, outputTokens: 42 },
    ]);
  });

  it('resolves the default path on each call and creates private storage', () => {
    expect(busHoplogPath()).toBe(join(root, 'fleet', 'bus', 'hops.jsonl'));
    expect(appendBusHop(ids)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(busHoplogPath()).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(busHoplogPath())).mode & 0o777).toBe(0o700);
    }
    vi.stubEnv('ASHLR_HOME', join(root, 'relocated'));
    expect(appendBusHop(ids)).toBe(true);
    expect(existsSync(join(root, 'relocated', 'fleet', 'bus', 'hops.jsonl'))).toBe(true);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '12', false, {}])(
    'rejects invalid token counts (%s) without writing', count => {
      expect(createBusHop(ids, { inputTokens: count })).toBeNull();
      expect(createBusHop(ids, { outputTokens: count })).toBeNull();
      expect(appendBusHop({ ...ids, inputTokens: count }, file)).toBe(false);
      expect(existsSync(file)).toBe(false);
    },
  );

  it('accepts exact safe counts, explicit unknowns and frozen detached metadata', () => {
    const source = { ...ids };
    const hop = createBusHop(source, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: null });
    source.id = 'changed';
    expect(hop).toEqual({ ...ids, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: null });
    expect(Object.isFrozen(hop)).toBe(true);
  });

  it.each(['', 'has space', 'line\nbreak', 'trailing\n', 'x'.repeat(129), 'nonascii-☃']) (
    'refuses malformed IDs (%s) without writing', id => {
      expect(appendBusHop({ ...ids, id }, file)).toBe(false);
      expect(existsSync(file)).toBe(false);
    },
  );

  it('refuses credential-shaped labels without exposing them in diagnostics', () => {
    // FAKE credential fixture, built only at runtime. Assert booleans to keep it out of output.
    const fake = ['gh', 'p_', 'FAKE', 'x'.repeat(40)].join('');
    for (const key of ['id', 'from', 'to']) {
      expect(appendBusHop({ ...ids, [key]: fake }, file)).toBe(false);
    }
    expect(existsSync(file)).toBe(false);
  });

  it('rejects proxies, inherited IDs and metadata accessors without invoking them', () => {
    const trap = vi.fn(() => { throw new Error('private trap'); });
    expect(busMessageIds(new Proxy(ids, { get: trap, getOwnPropertyDescriptor: trap }))).toBeNull();
    expect(busMessageIds(Object.create(ids))).toBeNull();
    expect(busMessageIds({ ...ids, get id() { return trap(); } })).toBeNull();
    expect(createBusHop(ids, { get inputTokens() { return trap(); } })).toBeNull();
    expect(trap).not.toHaveBeenCalled();
    expect(appendBusHop(null, file)).toBe(false);
  });

  it('refuses symlink and hardlink destinations without altering the target', () => {
    const target = join(root, 'target');
    writeFileSync(target, 'preserve', { mode: 0o600 });
    mkdirSync(dirname(file), { mode: 0o700 });
    symlinkSync(target, file);
    expect(appendBusHop(ids, file)).toBe(false);
    rmSync(file);
    linkSync(target, file);
    expect(appendBusHop(ids, file)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('preserve');
  });

  it('refuses a symlinked log directory and a nonregular destination', () => {
    const target = join(root, 'target');
    mkdirSync(target);
    symlinkSync(target, dirname(file), 'dir');
    expect(appendBusHop(ids, file)).toBe(false);
    expect(existsSync(join(target, 'hops.jsonl'))).toBe(false);
    rmSync(dirname(file));
    mkdirSync(file, { recursive: true });
    expect(appendBusHop(ids, file)).toBe(false);
  });

  it('leaves a permissive existing file untouched', () => {
    mkdirSync(dirname(file), { mode: 0o700 });
    writeFileSync(file, '', { mode: 0o600 });
    chmodSync(file, 0o644);
    const result = appendBusHop(ids, file);
    expect(result).toBe(process.platform === 'win32');
    if (process.platform !== 'win32') expect(statSync(file).size).toBe(0);
  });

  it('refuses a full log without deleting history', () => {
    mkdirSync(dirname(file), { mode: 0o700 });
    writeFileSync(file, '', { mode: 0o600 });
    truncateSync(file, BUS_HOPLOG_MAX_BYTES);
    expect(appendBusHop(ids, file)).toBe(false);
    expect(statSync(file).size).toBe(BUS_HOPLOG_MAX_BYTES);
  });

  it('refuses existing permissive directories instead of changing their permissions', () => {
    mkdirSync(dirname(file), { mode: 0o755 });
    const result = appendBusHop(ids, file);
    expect(result).toBe(process.platform === 'win32');
    if (process.platform !== 'win32') {
      expect(existsSync(file)).toBe(false);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o755);
    }
  });
});
