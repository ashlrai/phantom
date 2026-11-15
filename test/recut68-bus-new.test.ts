import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAppsChangesPublisher } from '../src/core/fleet/apps-changes-bus.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { ChangeEvent, SummaryEvent } from '../src/cli/fleet-apps-changes.js';

const transition: ChangeEvent = { type: 'transition', app: 'phantom', state: 'running', time: '2026-11-10T00:00:00.000Z' };
const summary: SummaryEvent = { type: 'summary', outcome: 'complete', samples: 3, transitions: 1 };

describe('recut68: apps-changes bus publisher (PR #4620)', () => {
  it('posts normalized change and summary events to the local bus inbox', () => {
    const root = mkdtempSync(join(tmpdir(), 'recut68-bus-'));
    try {
      const publish = createAppsChangesPublisher(root);
      expect(publish(transition)).toBe(true);
      expect(publish(summary)).toBe(true);

      const page = listBusInboxAfter(0, 50, { root });
      if (page.status !== 'ok') throw new Error(`inbox status ${page.status}`);
      expect(page.messages).toHaveLength(2);

      const [first, second] = page.messages.map(row => row.envelope);
      expect(first?.from).toBe('apps-changes');
      expect(first?.to).toBe('leaders');
      expect(first?.priority).toBe('P2');
      expect(first?.id).toMatch(/^apps-changes-/);
      expect(second?.id).not.toBe(first?.id);

      const firstBody = first?.body as Record<string, unknown>;
      expect(firstBody.kind).toBe('apps-changes.event.v1');
      expect(firstBody.sequence).toBe(1);
      expect(firstBody.type).toBe('transition');
      expect(firstBody.app).toBe('phantom');
      expect(firstBody.state).toBe('running');
      expect(typeof firstBody.invocationId).toBe('string');

      const secondBody = second?.body as Record<string, unknown>;
      expect(secondBody.sequence).toBe(2);
      expect(secondBody.type).toBe('summary');
      expect(secondBody.outcome).toBe('complete');
      expect(secondBody.samples).toBe(3);
      expect(secondBody.invocationId).toBe(firstBody.invocationId);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps a stable invocationId per publisher and isolates append failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'recut68-bus-'));
    try {
      const publishA = createAppsChangesPublisher(root);
      const publishB = createAppsChangesPublisher(root);
      expect(publishA(transition)).toBe(true);
      expect(publishB(transition)).toBe(true);

      const page = listBusInboxAfter(0, 50, { root });
      if (page.status !== 'ok') throw new Error(`inbox status ${page.status}`);
      const bodies = page.messages.map(row => row.envelope.body as Record<string, unknown>);
      expect(bodies[0]!.invocationId).not.toBe(bodies[1]!.invocationId);
      expect(bodies.map(b => b.sequence)).toEqual([1, 1]);

      const failing = createAppsChangesPublisher(root, () => { throw new Error('down'); });
      expect(failing(transition)).toBe(false);
      const rejected = createAppsChangesPublisher(root, () => ({ status: 'full' }));
      expect(rejected(transition)).toBe(false);

      const after = listBusInboxAfter(0, 50, { root });
      if (after.status !== 'ok') throw new Error(`inbox status ${after.status}`);
      expect(after.messages).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
