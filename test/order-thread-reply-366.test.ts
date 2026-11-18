import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRouteReplyFacts, threadReplyOf } from '../src/core/fleet/order-thread-reply.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);
const routes = new Map([[A, { delivered: true, attempted: false }], [B, { delivered: false, attempted: true }], [C, { delivered: false, attempted: false }]]);

describe('threadReplyOf', () => {
  it('truth table', () => {
    expect(threadReplyOf(undefined, routes)).toBe('unknown');
    expect(threadReplyOf(A, null)).toBe('unknown');
    expect(threadReplyOf(D, routes)).toBe('none');
    expect(threadReplyOf(A, routes)).toBe('delivered');
    expect(threadReplyOf(B, routes)).toBe('attempted');
    expect(threadReplyOf(C, routes)).toBe('none');
    expect(threadReplyOf(A, new Map([[A, { delivered: true, attempted: true }]]))).toBe('delivered');
  });
});

function store(text?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'thread-reply-'));
  if (text !== undefined) {
    mkdirSync(join(dir, 'leader'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'leader', 'network-state.json'), text, { mode: 0o600 });
  }
  return dir;
}
const route = (reply?: object) => ({ channel: 'slack', recipient: 'U-SECRET', channelRef: 'C-SECRET', receivedAt: 1, ...(reply ? { reply } : {}) });

describe('readRouteReplyFacts', () => {
  it('returns null for a missing, malformed or oversized store', () => {
    expect(readRouteReplyFacts({ runsDir: store() })).toBeNull();
    expect(readRouteReplyFacts({ runsDir: store('{nope') })).toBeNull();
    expect(readRouteReplyFacts({ runsDir: store(JSON.stringify({ version: 2, routes: {} })) })).toBeNull();
    expect(readRouteReplyFacts({ runsDir: store(JSON.stringify({ version: 1, routes: { 'not-hex': route() } })) })).toBeNull();
    expect(readRouteReplyFacts({ runsDir: store(JSON.stringify({ version: 1, routes: { [A]: route({ delivered: 'yes', attempted: false }) } })) })).toBeNull();
    expect(readRouteReplyFacts({ runsDir: store(JSON.stringify({ version: 1, routes: { [A]: route() } })), maxBytes: 10 })).toBeNull();
  });
  it('returns only booleans keyed by request id', () => {
    const state = { version: 1, routes: {
      [A]: route({ text: 'SECRET REPLY', fingerprint: 'f', at: 1, recorded: true, published: true, delivered: true, attempted: false }),
      [B]: route({ text: 'x', delivered: false, attempted: true }),
      [C]: route(),
    } };
    const out = readRouteReplyFacts({ runsDir: store(JSON.stringify(state)) });
    expect(out).not.toBeNull();
    expect([...out!.entries()]).toEqual([
      [A, { delivered: true, attempted: false }], [B, { delivered: false, attempted: true }], [C, { delivered: false, attempted: false }],
    ]);
    expect(JSON.stringify([...out!])).not.toMatch(/SECRET|slack|U-|C-S|text/);
  });
});
