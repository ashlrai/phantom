/** Validate every src/cli/fleet-<verb>.ts ships the export the dispatcher expects.

The convention dispatcher is in src/cli/fleet-subcommand-resolve.ts, exported
as resolveFleetSubcommand.  For a verb suffix "bus-claim" it produces:
  module: "./fleet-bus-claim.js"
  exportName: "cmdFleetBusClaim"

This test scans all fleet-*.ts files in src/cli/, derives the expected export
name the same way the dispatcher does, reads each file's source text, and
asserts the expected export is present — without dynamically importing (which
would pull in every verb's dependency graph).

Files deliberately NOT verbs (test stubs and helpers) are listed in ALLOW_LIST.
*/

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Helpers (copied from the dispatcher so the test is self-contained)  */
/*  We import the real helper when it's re-exported, but reproduce     */
/*  the rule here so the test doesn't depend on a module that might   */
/*  not yet exist in older checkouts.                                  */
/* ------------------------------------------------------------------ */

/** Rebuild the expected export name: "cmdFleet" + TitleCase parts. */
function expectedExportName(filename: string): string {
  // filename is like "fleet-bus-claim.ts"
  const base = filename.replace(/^fleet-/, '').replace(/\.ts$/, '');
  return (
    'cmdFleet' +
    base
      .split('-')
      .map(part => part[0]?.toUpperCase() + part.slice(1))
      .join('')
  );
}

/* ------------------------------------------------------------------ */
/*  Allow-list: fleet-*.ts files that are helpers or tests, NOT verbs. */
/*  New verbs must follow the convention; these stay excluded          */
/*  because they are either test stubs or internal helpers.            */
/* ------------------------------------------------------------------ */

const ALLOW_LIST: Record<string, string> = {
  'fleet-subcommand-resolve.ts': 'helper — resolves verb names, not a CLI verb',
  'fleet-subcommand-registry.ts': 'generated registry — populated by gen-fleet-registry.mjs',
  'fleet-planner-tick.test.ts': 'test stub — exported functions are test fixtures',
  'fleet-ready-supply.test.ts': 'test stub — exported functions are test fixtures',
  'fleet-red-fix.test.ts': 'test stub — exported functions are test fixtures',
  'fleet-superseded-close.test.ts': 'test stub — exported functions are test fixtures',
};

const CLI_DIR = join(__dirname, '..', 'src', 'cli');

describe('fleet verb export convention', () => {
  it('every src/cli/fleet-<verb>.ts exports the expected cmdFleet<Name>', () => {
    const files = readdirSync(CLI_DIR)
      .filter(f => f.startsWith('fleet-') && f.endsWith('.ts'))
      .filter(f => !ALLOW_LIST[f]);

    const failures: string[] = [];

    for (const file of files) {
      const exportName = expectedExportName(file);
      const source = readFileSync(join(CLI_DIR, file), 'utf-8');

      // Match: export async function <name>, export function <name>,
      // or  export const <name> = async
      const hasExport = (
        new RegExp(`export\\s+(async\\s+)?function\\s+${escapeRegex(exportName)}`, 'u').test(source) ||
        new RegExp(`export\\s+const\\s+${escapeRegex(exportName)}\\s*=\\s*async`, 'u').test(source)
      );

      if (!hasExport) {
        failures.push(`${file} — expected "${exportName}" not found`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Fleet verb convention violations (${failures.length}):\n` + failures.join('\n'),
      );
    }
  });
});

/** Escape regex special characters so the search is literal. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
