import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleetAppsChanges, type FleetAppsChangesDeps } from '../src/cli/fleet-apps-changes.js';
import { createAppsChangesPublisher } from '../src/core/fleet/apps-changes-bus.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';

const app = FLEET_APPS[0]!;
const stamp = '2026-11-01T00:00:00.000Z';
function fake() {
  let time = 0, index = 0;
  const states = [true, false, null];
  return {
    now: () => time,
    sleep: async (ms: number) => { time += ms; },
    runChild: vi.fn(async (..._args: Parameters<NonNullable<FleetAppsChangesDeps['runChild']>>) => ({ code: 0, stdout: JSON.stringify({ v: 1, generatedAt: stamp, available: true,
      apps: [{ app, running: states[Math.min(index++, 2)], checkedAt: stamp }] }) })),
  };
}
async function run(root: string, extra: string[], deps: FleetAppsChangesDeps) {
  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  try {
    const code = await cmdFleetAppsChanges(['--duration-ms', '300', '--interval-ms', '100', '--root', root, '--app', app, '--jsonl', ...extra], deps);
    return { code, events: output.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) };
  } finally { write.mockRestore(); }
}
describe('passive apps-changes bus', () => {
  it('publishes scoped ordered events with unique invocation IDs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'changes-bus-'));
    try {
      for (let i = 0; i < 2; i++) {
        const deps = fake();
        const result = await run(root, ['--bus'], deps);
        expect(result.code).toBe(0);
        expect(result.events.at(-1)).toMatchObject({ outcome: 'complete', samples: 3, transitions: 2, published: 4, failed: 0 });
        expect(deps.runChild.mock.calls.every(([argv]) => argv[1] === 'apps-status')).toBe(true);
      }
      const page = listBusInboxAfter(0, 50, { root });
      expect(page.status).toBe('ok');
      if (page.status !== 'ok') throw new Error('inbox unavailable');
      expect(page.messages).toHaveLength(8);
      const envelopes = page.messages.map(row => row.envelope);
      expect(new Set(envelopes.map(e => e.id)).size).toBe(8);
      const bodies = envelopes.map(e => e.body as Record<string, unknown>);
      expect(bodies.map(b => b.sequence)).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
      expect(bodies[0]!.invocationId).not.toBe(bodies[4]!.invocationId);
      expect(bodies.slice(0, 4).map(b => [b.type, b.app, b.state])).toEqual([
        ['baseline', app, 'running'], ['transition', app, 'stopped'], ['transition', app, 'unknown'], ['summary', undefined, undefined],
      ]);
      expect(envelopes.every(e => e.from === 'apps-changes' && e.to === 'leaders')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('does not write without the flag and isolates append failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'changes-bus-'));
    try {
      const noBus = await run(root, [], fake());
      expect(noBus.events.at(-1)).not.toHaveProperty('published');
      expect(listBusInboxAfter(0, 50, { root })).toMatchObject({ status: 'ok', messages: [] });
      const result = await run(root, ['--bus'], { ...fake(), createBusPublisher: path => createAppsChangesPublisher(path, () => { throw new Error('private'); }) });
      expect(result.code).toBe(0);
      expect(result.events.at(-1)).toMatchObject({ outcome: 'complete', samples: 3, transitions: 2, published: 0, failed: 4 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
