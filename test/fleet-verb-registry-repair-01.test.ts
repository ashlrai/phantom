import { describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet-entry.js';
import { generateFleetRegistry } from '../scripts/gen-fleet-registry.mjs';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

async function dispatchReachesVerb(args: string[]): Promise<{ errText: string; outText: string; code: number }> {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const code = await cmdFleet(args);
    return {
      code,
      errText: stderr.mock.calls.map(call => String(call[0])).join(''),
      outText: stdout.mock.calls.map(call => String(call[0])).join('\n'),
    };
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
  }
}

describe('RQ-PHX-VERBREGISTRYREPAIR01: merged fleet verbs reachable through the registry', { timeout: 120_000 }, () => {
  it.each([
    ['guardian-verify', 'cmdFleetGuardianVerify'],
    ['bus-reply', 'cmdFleetBusReply'],
  ] as const)('registry loader for %s yields %s', async (verb, exportName) => {
    const loader = FLEET_SUBCOMMAND_LOADERS[verb];
    expect(typeof loader).toBe('function');
    const loaded = await loader!();
    expect(typeof loaded[exportName]).toBe('function');
    expect((loaded[exportName] as { name?: string }).name).toBe(exportName);
  });

  it('generated registry --check is in sync after the repair', () => {
    expect(generateFleetRegistry(['--check'])).toBe(0);
  });

  it('fleet guardian-verify with no flags reaches its own validation result, not unknown-subcommand', async () => {
    const { code, errText } = await dispatchReachesVerb(['guardian-verify']);
    // cmdFleetGuardianVerify: runGuardianVerifyLoop throws on non-absolute paths before any file I/O.
    expect(code).toBe(3);
    expect(errText).toContain('guardian-verify could not validate or process manifest/state');
    expect(errText).not.toContain('unknown fleet subcommand');
  });

  it('fleet bus-reply with no flags reaches its own invalid-input result, not unknown-subcommand', async () => {
    const { code, errText, outText } = await dispatchReachesVerb(['bus-reply']);
    expect(code).toBe(2);
    expect(JSON.parse(outText)).toMatchObject({ outcome: 'invalid-input' });
    expect(errText).not.toContain('unknown fleet subcommand');
  });

  it('fleet guardian-verify with a bad flag reaches its own argument parser, not unknown-subcommand', async () => {
    const { code, errText } = await dispatchReachesVerb(['guardian-verify', '--bogus']);
    expect(code).toBe(2);
    expect(errText).toContain('invalid guardian-verify arguments');
    expect(errText).not.toContain('unknown fleet subcommand');
  });
});
