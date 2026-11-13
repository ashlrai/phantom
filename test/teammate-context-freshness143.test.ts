import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { recordTeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { runTeammateResponder, teammateOperationalContext } from '../src/core/comms/imessage-teammate-worker.js';
import { TEAMMATE_LIVE_STATUS_STALE_MS } from '../src/core/comms/teammate-context-evidence.js';

const NOW = Date.parse('2026-11-11T06:00:00.000Z');
const NOW_ISO = '2026-11-11T06:00:00.000Z';
const HOUR = 3_600_000;

let runsDir: string;
const savedEnv: Record<string, string | undefined> = {};

const put = (relative: string, text: string, ageMs: number): void => {
  const file = join(runsDir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const stamp = new Date(NOW - ageMs);
  utimesSync(file, stamp, stamp);
};

const attribution = (context: string, relative: string): string => {
  const line = context.split('\n').find(value => value.startsWith(`## ${relative}:`));
  expect(line, `attribution line for ${relative}`).toBeDefined();
  return line!;
};

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'teammate-context-'));
  for (const key of ['PHANTOM_COMMS_SOURCE_SHA', 'PHANTOM_COMMS_DESKTOP_VERSION']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(runsDir, { recursive: true, force: true });
});

describe('teammate operational context freshness', () => {
  it('distinguishes fresh, stale and durable sources by their own file times', () => {
    put('leader/VISION.md', 'Durable mission text.', 30 * 24 * HOUR);
    put('supervisor/status-main-guardian.md', '# Main guardian status\nAll green.', 2 * HOUR);
    put('queue/status.json', '{"lanes":{}}', 60_000);

    const context = teammateOperationalContext(runsDir, () => NOW);

    expect(context).toContain(`Context assembled: ${NOW_ISO}`);
    expect(context).toContain('Responder source: unknown');
    expect(context).toContain('Installed desktop version: unknown');

    const vision = attribution(context, 'leader/VISION.md');
    expect(vision).toContain('state: present');
    expect(vision).toContain('durable context, not live status');
    expect(vision).not.toContain('stale');
    expect(vision).toContain(new Date(NOW - 30 * 24 * HOUR).toISOString());

    const guardian = attribution(context, 'supervisor/status-main-guardian.md');
    expect(guardian).toContain('state: stale');
    expect(guardian).toContain('status record');
    expect(guardian).toContain(`stale after ${TEAMMATE_LIVE_STATUS_STALE_MS / 60_000}m`);
    expect(guardian).toContain(new Date(NOW - 2 * HOUR).toISOString());

    const queue = attribution(context, 'queue/status.json');
    expect(queue).toContain('state: fresh');
    expect(queue).toContain('status record');
    expect(context).toContain('Durable mission text.');
    expect(context).toContain('All green.');
  });

  it('reports missing and unavailable sources as unknown states, never fresh', () => {
    const context = teammateOperationalContext(runsDir, () => NOW);
    for (const relative of ['leader/VISION.md', 'supervisor/status-main-guardian.md', 'queue/status.json']) {
      expect(attribution(context, relative)).toContain('state: missing');
    }

    put('leader/VISION.md', 'vision', 1000);
    mkdirSync(join(runsDir, 'queue', 'status.json'), { recursive: true });
    const mixed = teammateOperationalContext(runsDir, () => NOW);
    expect(attribution(mixed, 'leader/VISION.md')).toContain('state: present');
    expect(attribution(mixed, 'queue/status.json')).toContain('state: unavailable');
    expect(attribution(mixed, 'supervisor/status-main-guardian.md')).toContain('state: missing');
  });

  it('keeps every stale and unknown label inside the 4000-character bound', () => {
    put('leader/VISION.md', `VISION-${'x'.repeat(9000)}`, 30 * 24 * HOUR);
    put('supervisor/status-main-guardian.md', `GUARDIAN-${'y'.repeat(9000)}`, 5 * HOUR);
    put('queue/status.json', `QUEUE-${'z'.repeat(9000)}`, 5 * HOUR);

    const context = teammateOperationalContext(runsDir, () => NOW);

    expect(context.length).toBeLessThanOrEqual(4000);
    expect(context).toContain('Responder source: unknown');
    expect(context).toContain('state: stale');
    const staleAt = context.indexOf('state: stale');
    const guardianBody = context.indexOf('GUARDIAN-');
    expect(guardianBody === -1 || staleAt < guardianBody).toBe(true);
  });

  it('uses injected time through the real worker path without extra model calls', async () => {
    put('queue/status.json', '{"lanes":{}}', 60_000);
    const cfg = {} as AshlrConfig;
    recordTeammateText({ rowid: 10, handle: 'agent@example.test', text: 'Please report the current blocker?' }, runsDir, new Date(NOW));
    let captured = '';
    const generate = vi.fn(async (_text: string, context: string) => {
      captured = context;
      return 'Observed work is pending.';
    });
    const receipt = { rowid: 99, sent: true, delivered: true, error: 0 };

    const result = await runTeammateResponder(cfg, {
      runsDir,
      now: () => NOW,
      approved: () => 'agent@example.test',
      generate,
      send: vi.fn(async () => 'accepted' as const),
      reconcile: vi.fn(async () => receipt),
    });

    expect(result).toMatchObject({ state: 'healthy', sent: 1 });
    expect(generate).toHaveBeenCalledOnce();
    expect(captured).toContain(`Context assembled: ${NOW_ISO}`);
    expect(captured).toContain('state: fresh');
    expect(captured).toContain('state: missing');
  });
});
