import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetImessagePath } from '../src/cli/fleet-imessage-path.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { cmdFleet } from '../src/cli/fleet.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { AshlrConfig } from '../src/core/types.js';

const cfg = (enabled: boolean) => ({ comms: { enabled, imessageHandle: 'fake-private-handle' } }) as AshlrConfig;
const good = { platform: 'darwin', config: () => cfg(true), probe: () => 'ok' as const, cursor: () => 1 };
afterEach(() => vi.restoreAllMocks());
describe('fleet iMessage path', () => {
  it('reports owner-only scope without claiming collaborator delivery', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetImessagePath(['--json'], good)).toBe(0);
    const output = String(log.mock.calls[0]?.[0]);
    const report = JSON.parse(output);
    expect(report.configuration.state).toBe('configured');
    expect(report.chatDb.state).toBe('readable');
    expect(report.cursor.state).toBe('present');
    expect(report.ownerReply.state).toBe('unknown');
    expect(report.collaboratorIntake.state).toBe('unsupported');
    expect(report.collaboratorDelivery.state).toBe('unsupported');
    expect(output).not.toContain('fake-private-handle');
  });
  it('handles Linux, disabled configuration, unavailable database and cursor', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdFleetImessagePath(['--json'], { ...good, platform: 'linux', config: () => cfg(false), cursor: () => null });
    let report = JSON.parse(String(log.mock.calls.pop()?.[0]));
    expect(report.platform.state).toBe('unsupported');
    expect(report.configuration.state).toBe('disabled');
    expect(report.chatDb.state).toBe('unknown');
    expect(report.cursor.state).toBe('unknown');
    for (const state of ['missing', 'blocked_full_disk_access'] as const) {
      await cmdFleetImessagePath(['--json'], { ...good, probe: () => state });
      report = JSON.parse(String(log.mock.calls.pop()?.[0]));
      expect(report.chatDb.state).toBe('unavailable');
    }
  });
  it('suppresses thrown evidence and provides actionable text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fail = () => { throw new Error('fake-private-handle'); };
    expect(await cmdFleetImessagePath([], { ...good, config: fail, probe: fail, cursor: fail })).toBe(0);
    const output = log.mock.calls.map(call => call[0]).join('\n');
    expect(output).not.toContain('fake-private-handle');
    expect(output).toContain('CONFIG_UNAVAILABLE');
    expect(output).toContain('phm imessage doctor --json');
    expect(output).toContain('phm imessage poll --json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetImessagePath(['--json', '--json'], good)).toBe(2);
  });
  it('exposes the convention but the actual dispatcher rejects the missing loader', async () => {
    expect(resolveFleetSubcommand('imessage-path')?.exportName).toBe('cmdFleetImessagePath');
    expect(Object.hasOwn(FLEET_SUBCOMMAND_LOADERS, 'imessage-path')).toBe(false);
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleet(['imessage-path', '--json'])).toBe(2);
    expect(error.mock.calls.map(call => String(call[0])).join('')).toContain('unknown fleet subcommand');
  });
});
