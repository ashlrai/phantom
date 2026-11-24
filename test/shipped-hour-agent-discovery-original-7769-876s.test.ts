import { describe, expect, it, vi } from 'vitest';
import { AGENT_COMMANDS } from '../src/cli/help.js';
import { cmdShipped } from '../src/cli/shipped.js';
import { buildHourShipped } from '../src/core/fleet/shipped-hour.js';

describe('one-hour shipped agent discovery', () => {
  it('advertises the read-only invocation and preserves unknown and zero totals', async () => {
    const row = AGENT_COMMANDS.find(command => command.usage === 'phm shipped --since 1h [--json]');
    expect(row).toMatchObject({ safety: 'read', jsonShape: expect.stringContaining('fleet.shipped.v1') });
    expect(row!.description).toMatch(/merged changes/i);
    expect(row!.description).toMatch(/published or installed/i);
    const args = row!.usage.replace('[--json]', '--json').split(' ').slice(2);
    const now = Date.parse('2026-11-24T00:00:00Z');
    const hour = vi.fn().mockResolvedValueOnce(buildHourShipped([null], now))
      .mockResolvedValueOnce(buildHourShipped([{ repo: 'example/repo', commits: [] }], now));
    const fleet = vi.fn();
    const source = vi.fn();
    const out = vi.fn();
    const deps = { hour, fleet, source, out, now: () => now };
    expect(await cmdShipped(args, deps)).toBe(1);
    expect(JSON.parse(out.mock.calls[0]![0] as string)).toMatchObject({ schema: 'fleet.shipped.v1', window: '1h', complete: false, total: null });
    expect(await cmdShipped(args, deps)).toBe(0);
    expect(JSON.parse(out.mock.calls[1]![0] as string)).toMatchObject({ schema: 'fleet.shipped.v1', window: '1h', complete: true, total: 0 });
    expect(hour).toHaveBeenCalledTimes(2);
    expect(fleet).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
  });
});
