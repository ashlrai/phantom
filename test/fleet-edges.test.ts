import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { readFleetEdges } from '../src/core/fleet/fleet-edges.js';

describe('fleet edges', () => {
  it('projects live receipts, preserves unknown providers, and omits bodies', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-edges-'));
    const options = { root, now: () => 1000 };
    try {
      expect(readFleetEdges(options)).toMatchObject({ source: 'missing', edges: null });
      const post = (id: string, from: string, to: string, vendor: string) => appendBusInbox({ id, from, to, priority: 'P2', ttl: 5000, body: { text: 'private body' }, channel: 'bus', channel_ref: id, sender: { agent_id: from, vendor, human: false, team: true }, external: false }, options);
      expect(post('one', 'a', 'b', 'openai').status).toBe('posted');
      expect(post('two', 'b', 'c', 'anthropic').status).toBe('posted');
      expect(post('three', 'a', 'b', 'openai').status).toBe('posted');
      const result = readFleetEdges(options);
      expect(result.edges).toEqual([
        { from: { address: 'a', provider: 'openai' }, to: { address: 'b', provider: 'anthropic' }, messages: 2, lastAt: 1000 },
        { from: { address: 'b', provider: 'anthropic' }, to: { address: 'c', provider: null }, messages: 1, lastAt: 1000 },
      ]);
      expect(JSON.stringify(result)).not.toContain('private body');
      expect(readFleetEdges({ root, now: () => 7000 }).edges).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
