import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { recordTeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { runTeammateResponder, teammateOperationalContext } from '../src/core/comms/imessage-teammate-worker.js';
import { CONTEXT_MAX_CHARS } from '../src/core/comms/teammate-context-evidence.js';

it('passes attributed bounded file evidence through the real responder seam', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'context-salvage-'));
  const now = Date.parse('2026-11-11T06:00:00Z');
  const previousSha = process.env.PHANTOM_COMMS_SOURCE_SHA;
  const previousVersion = process.env.PHANTOM_COMMS_DESKTOP_VERSION;
  delete process.env.PHANTOM_COMMS_SOURCE_SHA;
  delete process.env.PHANTOM_COMMS_DESKTOP_VERSION;
  try {
    for (const [path, body, age] of [
      ['leader/VISION.md', `VISION ${'v'.repeat(9000)}`, 86400000],
      ['supervisor/status-main-guardian.md', `GUARDIAN ${'g'.repeat(9000)}`, 3600000],
      ['queue/status.json', `QUEUE ${'q'.repeat(9000)}`, 60000],
    ] as const) {
      const file = join(runsDir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      utimesSync(file, new Date(now - age), new Date(now - age));
    }
    const context = teammateOperationalContext(runsDir, () => now);
    expect(context.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(context).toContain('Responder source: unknown');
    expect(context).toContain('Installed desktop version: unknown');
    for (const [path, label, marker] of [
      ['leader/VISION.md', 'durable context, not live status', 'VISION '],
      ['supervisor/status-main-guardian.md', 'state: stale', 'GUARDIAN '],
      ['queue/status.json', 'state: fresh', 'QUEUE '],
    ] as const) {
      const start = context.indexOf(`## ${path}:`);
      const body = context.indexOf(marker);
      if (body !== -1) {
        expect(start).toBeGreaterThanOrEqual(0);
        expect(context.slice(start, body)).toContain(label);
      }
    }
    recordTeammateText({ rowid: 10, handle: 'agent@example.test', text: 'Please report the current blocker?' }, runsDir, new Date(now));
    const generate = vi.fn(async (_input: string, _context: string) => 'Observed work is pending.');
    await runTeammateResponder({} as AshlrConfig, {
      runsDir, now: () => now, approved: () => 'agent@example.test', generate,
      send: vi.fn(async () => 'accepted' as const),
      reconcile: vi.fn(async () => ({ rowid: 99, sent: true, delivered: true, error: 0 })),
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[1]).toBe(context);
  } finally {
    if (previousSha === undefined) delete process.env.PHANTOM_COMMS_SOURCE_SHA; else process.env.PHANTOM_COMMS_SOURCE_SHA = previousSha;
    if (previousVersion === undefined) delete process.env.PHANTOM_COMMS_DESKTOP_VERSION; else process.env.PHANTOM_COMMS_DESKTOP_VERSION = previousVersion;
    rmSync(runsDir, { recursive: true, force: true });
  }
});
