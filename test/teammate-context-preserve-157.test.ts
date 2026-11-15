import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { recordTeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { runTeammateResponder } from '../src/core/comms/imessage-teammate-worker.js';
import { CONTEXT_MAX_CHARS } from '../src/core/comms/teammate-context-evidence.js';

it('supplies attributed and scrubbed evidence to the actual responder generator', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'context-preserve-'));
  const now = Date.parse('2026-11-11T06:00:00Z');
  try {
    for (const [name, body, age] of [
      ['leader/VISION.md', 'A durable mission. TEST_TOKEN=fictional-value-157', 86400000],
      ['supervisor/status-main-guardian.md', `Old status. ${'x'.repeat(9000)}`, 7200000],
    ] as const) {
      const file = join(runsDir, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      utimesSync(file, new Date(now - age), new Date(now - age));
    }
    mkdirSync(join(runsDir, 'queue/status.json'), { recursive: true });
    recordTeammateText({ rowid: 157, handle: 'agent@example.test', text: 'What is the current status?' }, runsDir, new Date(now));
    const generate = vi.fn(async (_input: string, _context: string) => 'Status evidence is old.');
    const send = vi.fn(async () => 'refused' as const);
    await runTeammateResponder({} as AshlrConfig, { runsDir, now: () => now,
      approved: () => 'agent@example.test', generate, send, reconcile: vi.fn(async () => null) });
    expect(generate).toHaveBeenCalledOnce();
    const context = generate.mock.calls[0][1];
    expect(context).toContain(`Context assembled: ${new Date(now).toISOString()}`);
    expect(context).toContain('durable context, not live status');
    expect(context).not.toContain('fictional-value-157');
    expect(context).toContain('[REDACTED]');
    expect(context).toContain(`state: stale; file observed ${new Date(now - 7200000).toISOString()}`);
    expect(context).toContain('queue/status.json: state: unavailable');
    expect(context.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(send).toHaveBeenCalledOnce();
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
