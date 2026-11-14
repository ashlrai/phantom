import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { recordTeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { runTeammateResponder, teammateOperationalContext } from '../src/core/comms/imessage-teammate-worker.js';
import { CONTEXT_MAX_CHARS, TEAMMATE_LIVE_STATUS_STALE_MS } from '../src/core/comms/teammate-context-evidence.js';

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

  it('keeps every stale and unknown label inside the context bound', () => {
    put('leader/VISION.md', `VISION-${'x'.repeat(9000)}`, 30 * 24 * HOUR);
    put('supervisor/status-main-guardian.md', `GUARDIAN-${'y'.repeat(9000)}`, 5 * HOUR);
    put('queue/status.json', `QUEUE-${'z'.repeat(9000)}`, 5 * HOUR);

    const context = teammateOperationalContext(runsDir, () => NOW);

    expect(context.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(context).toContain('Responder source: unknown');
    expect(context).toContain('state: stale');
    const staleAt = context.indexOf('state: stale');
    const guardianBody = context.indexOf('GUARDIAN-');
    expect(guardianBody === -1 || staleAt < guardianBody).toBe(true);
  });

  it('surfaces fleet vitals: lane states, admission, publishes and dispatch log tails', () => {
    put('queue/status.json', JSON.stringify({
      last_tick: '2026-11-11T05:59:00-0500',
      queue_depth: 42,
      mem_free_pct: 91,
      swap_gb: 0,
      launched_this_tick: ['RQ-TEST-LAUNCH'],
      admission: { admit: true, gate_reason: null, load1: 21.5, load_max: 36, procs: 800, worktrees: 700, warnings: ['worktrees 700 > 40'] },
      lanes: {
        'codex-personal': { running: 1, target: 32, floor: 20, ceiling: 32, hard_cap: 32, held: false, queued: 33 },
        claude: { running: 4, target: 8, floor: 8, ceiling: 32, held: true, queued: 2 },
      },
      recent_publishes: [{ job: 'RQ-TEST-PUB', url: 'https://github.com/ashlrai/phantom/pull/9999' }],
      publishes_24h: 120,
      recent_events: ['2026-11-11 05:59:00 LAUNCH RQ-TEST-LAUNCH phantom claude work'],
      rollup_24h: { by_lane: { claude: { jobs: 201, merged: 18 }, devin: { jobs: 168, merged_prs: 68 } } },
    }), 60_000);
    // Over 96 KiB so the tail reader must skip the file head entirely.
    put('dispatch-events.log', `FIRST-EVENT-UNIQUE\n${'old line\n'.repeat(12000)}2026-11-11 05:59:30 LAUNCH RQ-TEST-LAUNCH phantom claude work\n`, 30_000);
    put('metrics/jobs.jsonl', `${'{"event":"launch","job":"RQ-TEST-LAUNCH"}\n'.repeat(500)}{"event":"publish","job":"RQ-TEST-PUB","url":"https://github.com/ashlrai/phantom/pull/9999"}\n`, 30_000);

    const context = teammateOperationalContext(runsDir, () => NOW);

    expect(context).toContain('fleet vitals');
    expect(context).toContain('queue_depth=42');
    expect(context).toContain('admission: admit=true');
    expect(context).toContain('load1=21.5/36');
    expect(context).toContain('lane codex-personal: running=1 target=32');
    expect(context).toContain('lane claude: running=4 target=8');
    expect(context).toContain('HELD');
    expect(context).toContain('pull/9999');
    expect(context).toContain('24h rollup');
    expect(context).toContain('dispatch-events tail');
    expect(context).toContain('LAUNCH RQ-TEST-LAUNCH phantom claude work');
    expect(context).toContain('jobs.jsonl tail');
    expect(context).toContain('RQ-TEST-PUB');
    // Log tails read from the end: content older than the tail window never enters context.
    expect(context).not.toContain('FIRST-EVENT-UNIQUE');
    expect(context.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
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
