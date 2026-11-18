import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_ENTRIES } from '../src/cli/help.js';
import { cliReferenceRows } from '../src/cli/docs-cli.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { checkCliReference, renderCliReference } from '../src/core/commands/cli-reference.js';
import { dispatchedCommands } from './helpers/cli-command-table.js';
// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('generated CLI reference', () => {
  it.each(['docs/CLI-REFERENCE.md', 'docs/cli.md'])('%s covers every registered command and each fleet help row once', (path) => {
    // Limit coverage to the command table: topic names in the overview cannot
    // substitute for missing commands such as `autonomy` or `run`.
    const page = read(path);
    const commands = path === 'docs/CLI-REFERENCE.md'
      ? [...page.matchAll(/^\| <code>phm (.*?)<\/code> \|/gm)].map(match => `    ${match[1]!.replace(/&#124;/g, '|').replace(/&lt;/g, '<').replace(/&gt;/g, '>')}  `).join('\n')
      : [...page.matchAll(/```text\n([\s\S]*?)```/g)].at(-1)?.[1] ?? '';
    const documented = new Set([...commands.matchAll(/^ {4}([a-z][a-z0-9-]*)(?:\s|$)/gm)].map(match => match[1]));
    const dispatched = dispatchedCommands(read('src/cli/index.ts'));
    expect(dispatched.length).toBeGreaterThan(70);
    expect(dispatched.filter(command => !documented.has(command)), `Missing commands in ${path}`).toEqual([]);

    for (const prefix of ['home ', 'map ', 'worklog ', 'nodes ', 'autonomy ', 'admission explain ', 'job pause|resume|stop|move ']) {
      const entries = HELP_ENTRIES.filter(entry => entry.cmd.startsWith(prefix));
      expect(entries, `Expected one registered help row for ${prefix}`).toHaveLength(1);
      const command = entries[0]!.cmd;
      expect(commands.split('\n').filter(line => line.trimStart().startsWith(`${command}  `)), `${path}: ${command}`).toHaveLength(1);
    }
  });

  it('keeps the fleet walkthrough linked and its Markdown targets resolvable', () => {
    const guide = 'docs/RUN-THE-FLEET.md';
    expect(read('README.md')).toContain(`/${guide})`);
    expect(read('docs/README.md')).toContain(`/${guide})`);
    expect(checkDocumentation({
      root: fileURLToPath(new URL('../', import.meta.url)), entrypoints: [guide],
    })).toMatchObject({ ok: true, errors: [], externalRequests: 0 });
  });

  it('matches every current registry row byte-for-byte', () => {
    const actual = readFileSync(new URL('../docs/CLI-REFERENCE.md', import.meta.url), 'utf8');
    expect(actual, 'Run node --import tsx scripts/generate-cli-reference.ts').toBe(
      renderCliReference(cliReferenceRows(HELP_ENTRIES)),
    );
    const rows = cliReferenceRows(HELP_ENTRIES);
    expect(checkCliReference(rows, actual).ok).toBe(true);
    expect([...actual.matchAll(/^\| <code>phm /gm)]).toHaveLength(rows.length);
    expect(Object.keys(FLEET_SUBCOMMAND_LOADERS).filter(verb =>
      !rows.some(row => row.cmd === `fleet ${verb}` || row.cmd.startsWith(`fleet ${verb} `)))).toEqual([]);
  });

  it('normalizes terminal formatting without dropping command options', () => {
    const rendered = renderCliReference([{ cmd: '  run --json  \r\n', desc: '\u001b[1mPhantom\u001b[0m \u2014 help  \r\n' }]);
    expect(rendered).toContain('Phantom - help |');
    expect(rendered).toContain('phm run --json</code>');
    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toMatch(/[\u2014\r]/);
  });
});
