import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAppsChangesPublisher } from '../src/core/fleet/apps-changes-bus.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { ChangeEvent, SummaryEvent } from '../src/cli/fleet-apps-changes.js';

const baseline: ChangeEvent = { type: 'baseline', app: 'fake-app', state: 'running', time: '2026-11-14T00:00:00.000Z' };
const transition: ChangeEvent = { type: 'transition', app: 'fake-app', state: 'stopped', time: '2026-11-14T00:00:10.000Z' };
const summary: SummaryEvent = { type: 'summary', outcome: 'complete', samples: 2, transitions: 1 };

const inbox = (root: string) => {
  const page = listBusInboxAfter(0, 50, { root });
  if (page.status !== 'ok') throw new Error(`inbox status ${page.status}`);
  return page.messages.map(row => row.envelope);
};

describe('recut-4638: apps-changes publisher behavior on current master', () => {
  it('numbers a mixed event stream monotonically under one invocationId and stable addressing', () => {
    const root = mkdtempSync(join(tmpdir(), 'recut-4638-'));
    try {
      const publish = createAppsChangesPublisher(root);
      expect(publish(baseline)).toBe(true);
      expect(publish(transition)).toBe(true);
      expect(publish(summary)).toBe(true);

      const envelopes = inbox(root);
      expect(envelopes).toHaveLength(3);
      expect(new Set(envelopes.map(e => e.id)).size).toBe(3);
      for (const envelope of envelopes) {
        expect(envelope).toMatchObject({ from: 'apps-changes', to: 'leaders', priority: 'P2' });
        expect(envelope.ttl).toBeGreaterThan(0);
      }
      const bodies = envelopes.map(e => e.body as Record<string, unknown>);
      expect(bodies.map(b => b.sequence)).toEqual([1, 2, 3]);
      expect(bodies.every(b => b.kind === 'apps-changes.event.v1' && b.invocationId === bodies[0]!.invocationId)).toBe(true);
      expect(bodies.map(b => [b.type, b.state])).toEqual([['baseline', 'running'], ['transition', 'stopped'], ['summary', undefined]]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('counts a duplicate append as delivered and stores nothing new', () => {
    const root = mkdtempSync(join(tmpdir(), 'recut-4638-'));
    try {
      const duplicate = createAppsChangesPublisher(root, () => ({ status: 'duplicate', id: 'fake-id', cursor: 1 }));
      expect(duplicate(transition)).toBe(true);
      const invalid = createAppsChangesPublisher(root, () => ({ status: 'invalid' }));
      expect(invalid(transition)).toBe(false);
      expect(inbox(root)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
