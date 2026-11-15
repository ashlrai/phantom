import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendEmailOutbox } from '../src/core/comms/email-outbox.js';
import { quotaLines } from '../src/core/comms/status-quota-lines.js';
import { telegramFleetStatus } from '../src/core/comms/telegram-fleet-status.js';
import type { CapacitySnapshot } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

const seat = (overrides: Partial<SeatCapacity>): SeatCapacity => ({
  seatId: 'seat-1',
  engine: 'codex',
  label: 'Seat One',
  free: false,
  windows: [],
  signedOut: false,
  reachable: true,
  contextWindow: null,
  observedAt: iso(NOW - MIN),
  spentTodayUsd: null,
  ...overrides,
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('recut of #3359: status quota lines', () => {
  it('quotaLines drops Claude session windows but keeps weekly prose resets', () => {
    const snapshot: CapacitySnapshot = {
      v: 1,
      publishedAt: iso(NOW - MIN),
      seats: [
        seat({
          engine: 'claude',
          label: 'Claude',
          windows: [
            { id: 'five_hour', usedPercent: 90, resetsAt: iso(NOW + 2 * HOUR), resetDescription: null, limitReached: false },
            { id: 'seven_day', usedPercent: 40, resetsAt: null, resetDescription: 'Resets Thursday at 3pm', limitReached: false },
          ],
        }),
      ],
    };
    expect(quotaLines(snapshot, NOW)).toEqual(['Quota Claude: seven_day: 40% · Resets Thursday at 3pm']);
  });

  it('telegramFleetStatus appends injected quota lines through the new reader seam', async () => {
    const body = await telegramFleetStatus({
      now: () => new Date(NOW),
      readQuota: () => ['Quota Codex Personal: codex_personal_secondary: 62% · resets in 2d 3h'],
    });
    expect(body).toContain('Quota Codex Personal: codex_personal_secondary: 62% · resets in 2d 3h');
  });

  it('an outside recipient still yields a draft, not a send', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recut-comms-61-'));
    roots.push(root);
    const outbox = join(root, 'outbox');
    mkdirSync(outbox);
    writeFileSync(join(outbox, 'reply.reply.eml'), 'To: outsider@example.invalid\nSubject: hi\n\nbody');
    const transport = vi.fn(async () => ({ ok: true }));
    const result = await sendEmailOutbox({
      dir: outbox,
      allowedRecipients: new Set(['owner@example.invalid']),
      transport,
      draftsRunsDir: root,
    });
    expect(result).toMatchObject({ drafted: 1, sent: 0 });
    expect(transport).not.toHaveBeenCalled();
  });
});
