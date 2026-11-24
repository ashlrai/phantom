/** Registry-derived top-level help, through the real source CLI in an empty home. */
import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { HELP_ENTRIES } from '../src/cli/help.js';
import { buildCommandCatalog } from '../src/core/commands/catalog.js';
import { createHelpFixture, helpFixtureSnapshot, removeHelpFixture, runHelp } from './helpers/top-level-help.mjs';

const commands = [...new Set(buildCommandCatalog(HELP_ENTRIES).map(command => command.name.split(' ')[0]!))];
// Exact parsers refuse --help with usage and exit 2. The existing
// cli-help-no-side-effects suite pins the first five; owner-live also
// requires one of its documented verbs before it accepts any flags.
const strictUsage = new Set(['team', 'improve', 'skills', 'signals', 'route', 'owner-live']);
const fixture = createHelpFixture();
afterAll(() => removeHelpFixture(fixture));

describe('top-level phm command --help', () => {
  for (const command of commands) {
    it(`should show help for ${command}`, () => {
      const before = helpFixtureSnapshot(fixture);
      const result = runHelp(fixture, [command, '--help']);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.output).toBe(strictUsage.has(command) ? 2 : 0);
      expect(result.output).toMatch(/usage:|phm |ashlr /i);
      expect(helpFixtureSnapshot(fixture)).toEqual(before);
      expect(existsSync(fixture.effects)).toBe(false);
    }, 35_000);
  }

  it('should validate the test setup works correctly', () => {
    expect(commands).toContain('help');
    expect(commands).toContain('fleet');
    expect(commands.every(command => /^[a-z][a-z0-9-]*$/.test(command))).toBe(true);
    const result = runHelp(fixture, ['--help']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain('phm help');
  }, 35_000);
});
