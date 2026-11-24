/**
 * Delta on top of readme-command-table.test.ts: every top-level `phm` group in
 * the generated docs/CLI-REFERENCE.md must be named in the README, either in
 * "## Commands by goal" or in the "### Command table". Pure text; no CLI imports.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { documentedCommands } from './helpers/cli-command-table.js';

const ROOT = join(__dirname, '..');

/** Top-level command words from the reference table's first column. */
function referenceGroups(reference: string): string[] {
  const groups = new Set<string>();
  for (const m of reference.matchAll(/^\| <code>phm ([a-z][a-z0-9-]*)/gm)) groups.add(m[1]!);
  return [...groups];
}

/** `phm <group>` mentions inside the "## Commands by goal" section. */
function overviewBody(readme: string): string {
  const start = readme.indexOf('## Commands by goal');
  if (start === -1) throw new Error('README.md has no "## Commands by goal" section');
  const rest = readme.slice(start + 3);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

function missingGroups(reference: string, readme: string): string[] {
  const overview = [...overviewBody(readme).matchAll(/`phm ([a-z][a-z0-9-]*)/g)].map((m) => m[1]!);
  const named = new Set([...overview, ...documentedCommands(readme)]);
  return referenceGroups(reference).filter((g) => !named.has(g));
}

const reference = readFileSync(join(ROOT, 'docs', 'CLI-REFERENCE.md'), 'utf8');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

describe('README names every CLI reference group', () => {
  it('has no group missing from the overview or command table', () => {
    expect(referenceGroups(reference).length).toBeGreaterThan(70);
    expect(missingGroups(reference, readme), 'add these to README "## Commands by goal"').toEqual([]);
  });

  it('fails on a fixture reference with a group the README lacks', () => {
    const fixture = `${reference}\n| <code>phm zzgroup now [--json]</code> | Plain words. | - | - |\n`;
    expect(missingGroups(fixture, readme)).toEqual(['zzgroup']);
  });

  it('keeps the overview short enough for one screen', () => {
    expect(overviewBody(readme).split('\n').length).toBeLessThan(20);
  });
});
