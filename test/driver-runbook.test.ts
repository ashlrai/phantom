import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const runbook = readFileSync('docs/DRIVER.md', 'utf8');
const cli = readFileSync('src/cli/index.ts', 'utf8');

describe('driver runbook operating boundary', () => {
  it('checks the source-only runbook and its incoming navigation offline', () => {
    expect(checkDocumentation({ root: process.cwd(), entrypoints: [
      'docs/DRIVER.md', 'docs/README.md',
    ] })).toMatchObject({ ok: true, errors: [], externalRequests: 0 });
    for (const path of ['docs/README.md']) {
      expect(readFileSync(path, 'utf8')).toMatch(/\]\([^\n)]*\bDRIVER\.md\)/);
    }
  });

  it('marks every unregistered command example planned beside the example', () => {
    const commands = [...runbook.matchAll(/`phm ([^`]+)`/g)];
    expect(commands.length).toBeGreaterThan(0);
    for (const match of commands) {
      const command = match[1].split(/\s/)[0];
      if (cli.includes(`case '${command}':`)) continue;
      const lineStart = runbook.lastIndexOf('\n', match.index) + 1;
      const preceding = runbook.slice(lineStart, match.index);
      expect(preceding, match[0]).toMatch(/planned/i);
    }
    // The driver is now implemented: the CLI carries a `drive` case.
    // The runbook must cross-reference DRIVE.md and no longer claims every
    // command example is purely planned. The `cli` check verifies the
    // implementation exists so the runbook can document it.
    expect(cli).toMatch(/case ['"]drive['"]\s*:/);
    expect(runbook).not.toContain('\u2014');
  });
});
