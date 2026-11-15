/**
 * Reads the top-level command list two ways and compares them.
 *
 * `dispatchedCommands` parses main()'s `switch (cmd) { case '...': }` out of
 * src/cli/index.ts source text. `documentedCommands` reads the first code column
 * of the README's `### Command table`. Both are pure string functions so a test
 * can feed them a fixture instead of the real files.
 */

/**
 * Literal top-level command names dispatched by main()'s `switch (cmd)`.
 * Bounded to the switch body (up to the `} catch (err) {` that closes main()'s
 * try block) so an unrelated `case` elsewhere in the file is never picked up.
 * Case labels that start with a letter are commands; flag-shaped aliases such
 * as `--version` and the internal `__skills-audit-worker` entry are excluded.
 */
export function dispatchedCommands(indexSource: string): string[] {
  const switchStart = indexSource.indexOf('switch (cmd) {');
  if (switchStart === -1) {
    throw new Error(
      'cli-command-table: could not find `switch (cmd) {` in src/cli/index.ts; ' +
      'has main() been restructured? Update dispatchedCommands() to match.',
    );
  }
  const catchMarker = '\n  } catch (err) {';
  const switchEnd = indexSource.indexOf(catchMarker, switchStart);
  if (switchEnd === -1) {
    throw new Error(
      'cli-command-table: could not find the end of the dispatch switch ' +
      '(`} catch (err) {`) in src/cli/index.ts; update the boundary marker.',
    );
  }

  const switchBody = indexSource.slice(switchStart, switchEnd);
  const found = new Set<string>();
  for (const m of switchBody.matchAll(/case '([a-zA-Z][a-zA-Z0-9-]*)':/g)) {
    found.add(m[1]!);
  }
  return [...found];
}

/**
 * Command names in the README's `### Command table`. Reads each table row from
 * the second cell (the Commands column) and takes every `code` span there. The
 * header and separator rows are skipped. The section ends at the next heading.
 */
export function documentedCommands(readme: string): string[] {
  const lines = readme.split('\n');
  const heading = lines.indexOf('### Command table');
  if (heading === -1) {
    throw new Error('cli-command-table: README.md has no "### Command table" section');
  }
  const names: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (/^#{1,6} /.test(line)) break;
    if (!line.startsWith('|') || /^\|\s*(Group\s*\||---)/.test(line)) continue;
    const commands = line.split('|')[2] ?? '';
    for (const m of commands.matchAll(/`([a-zA-Z][a-zA-Z0-9-]*)`/g)) names.push(m[1]!);
  }
  return names;
}

/** Diff of the CLI dispatch list against the documented table. */
export interface CommandTableDiff {
  /** Dispatched by the CLI but not named in the README table. */
  undocumented: string[];
  /** Named in the README table but not dispatched by the CLI. */
  unknown: string[];
  /** Named more than once in the README table. */
  duplicated: string[];
}

export function compareCommandTable(dispatched: readonly string[], documented: readonly string[]): CommandTableDiff {
  const cli = new Set(dispatched);
  const docs = new Set(documented);
  return {
    undocumented: dispatched.filter((name) => !docs.has(name)),
    unknown: documented.filter((name) => !cli.has(name)),
    duplicated: [...new Set(documented.filter((name, i) => documented.indexOf(name) !== i))],
  };
}
