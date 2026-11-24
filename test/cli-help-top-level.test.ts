import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createHelpFixture, helpFixtureSnapshot, removeHelpFixture, runHelp } from './helpers/top-level-help.mjs';

const fixture = createHelpFixture();
afterAll(() => removeHelpFixture(fixture));

describe('CLI --help functionality', () => {
  it('should confirm that help system is functional', () => {
    const before = helpFixtureSnapshot(fixture);
    const result = runHelp(fixture, ['--help']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.output).toBe(0);
    for (const command of ['phm init', 'phm doctor', 'phm verse']) {
      expect(result.stdout).toContain(command);
    }
    expect(helpFixtureSnapshot(fixture)).toEqual(before);
    expect(existsSync(fixture.effects)).toBe(false);
  }, 35_000);

  it('should verify phm command structure exists', () => {
    const result = runHelp(fixture, ['help', 'core']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain('Core — index, navigate, configure');
    expect(result.stdout).toMatch(/^\s+config\s/m);
    expect(result.stdout).toMatch(/^\s+init\s/m);
  }, 35_000);
});
