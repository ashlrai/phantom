import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  beforeRead: undefined as undefined | (() => void),
  maxRead: Infinity,
  bytesRead: 0,
  readCalls: 0,
  closes: 0,
  failRead: false,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null) {
      const hook = io.beforeRead;
      io.beforeRead = undefined;
      hook?.();
      io.readCalls += 1;
      if (io.failRead) throw new Error('injected read failure');
      const count = actual.readSync(fd, buffer, offset, Math.min(length, io.maxRead), position);
      io.bytesRead += count;
      return count;
    },
    closeSync(fd: number) {
      io.closes += 1;
      actual.closeSync(fd);
    },
  };
});

import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_GRAPH_SEED_LIMITS, readFleetInventory, seedFleetGraph } from '../src/core/fleet/graph-seed.js';

const limit = FLEET_GRAPH_SEED_LIMITS.maxFileBytes;
let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'graph-inventory-bounded-'));
  file = join(root, 'fleet.json');
  io.beforeRead = undefined;
  io.maxRead = Infinity;
  io.bytesRead = 0;
  io.readCalls = 0;
  io.closes = 0;
  io.failRead = false;
});

afterEach(() => {
  io.beforeRead = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('bounded fleet inventory reads', () => {
  it('reads public files and handles short reads', () => {
    writeFileSync(file, '{"v":1}', { mode: 0o666 });
    if (process.platform !== 'win32') chmodSync(file, 0o666);
    io.maxRead = 2;
    expect(readFleetInventory(file)).toEqual({ ok: true, path: file, inventory: { v: 1 } });
    expect(io.readCalls).toBeGreaterThan(2);
    expect(io.bytesRead).toBe(7);
    expect(io.closes).toBe(1);
  });

  it('accepts the exact byte limit and rejects one byte more before reading', () => {
    writeFileSync(file, '{}' + ' '.repeat(limit - 2));
    expect(readFleetInventory(file)).toEqual({ ok: true, path: file, inventory: {} });
    expect(io.bytesRead).toBe(limit);
    expect(io.closes).toBe(1);
    appendFileSync(file, ' ');
    io.readCalls = 0;
    io.bytesRead = 0;
    expect(readFleetInventory(file)).toEqual({ ok: false, path: file, reason: 'too-large' });
    expect(io.readCalls).toBe(0);
    expect(io.bytesRead).toBe(0);
    expect(io.closes).toBe(2);
  });

  it('measures multibyte content in bytes before decoding', () => {
    writeFileSync(file, '"' + 'é'.repeat(limit / 2) + '"');
    expect(readFleetInventory(file)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(io.readCalls).toBe(0);
    expect(io.closes).toBe(1);
  });

  it('bounds reads when a file grows after the size check', () => {
    writeFileSync(file, '{}');
    io.beforeRead = () => appendFileSync(file, ' '.repeat(limit + 100));
    expect(readFleetInventory(file)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(io.bytesRead).toBe(limit + 1);
    expect(io.closes).toBe(1);
  });

  it('distinguishes malformed, missing, non-directory parents, directories, and read errors', () => {
    expect(readFleetInventory(file)).toMatchObject({ ok: false, reason: 'missing' });
    writeFileSync(file, '{');
    expect(readFleetInventory(file)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(readFleetInventory(join(file, 'child'))).toMatchObject({ ok: false, reason: 'missing' });
    const dir = join(root, 'directory');
    mkdirSync(dir);
    expect(readFleetInventory(dir)).toMatchObject({ ok: false, reason: 'unreadable' });
    io.failRead = true;
    expect(readFleetInventory(file)).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(io.closes).toBe(3);
  });

  it.each(['missing', 'malformed', 'too-large', 'directory'] as const)(
    'retains supplied seats when inventory is %s', async (kind) => {
      if (kind === 'malformed') writeFileSync(file, '{');
      if (kind === 'too-large') writeFileSync(file, ' '.repeat(limit + 1));
      if (kind === 'directory') mkdirSync(file);
      const seed = await seedFleetGraph({ fleetJsonPath: file, seats: [{ id: 'local-seat', engine: 'codex' }] });
      expect(seed.sources.seats).toEqual({ state: 'loaded', count: 1 });
      expect(seed.nodes).toContainEqual(expect.objectContaining({ id: 'seat:local-seat', evidence: 'recorded' }));
      expect(seed.sources.fleetJson.state).toBe(kind === 'missing' ? 'absent' : 'malformed');
      expect(seed.complete).toBe(kind === 'missing');
    },
  );
});
