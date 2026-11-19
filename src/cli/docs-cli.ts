import { resolve } from 'node:path';
import { CLI_REFERENCE_PATH, NO_HELP_TEXT, syncCliReference } from '../core/commands/cli-reference.js';
import type { CommandRow } from '../core/commands/catalog.js';
import { buildFleetVerbCatalog } from '../core/fleet/fleet-verb-catalog.js';
import { FLEET_SUBCOMMAND_LOADERS } from './fleet-subcommand-registry.js';
import { readVerbSource } from './fleet-verbs.js';

/** The help catalog plus fleet loaders, using the fleet's existing metadata reader. */
export function cliReferenceRows(help: readonly CommandRow[]): CommandRow[] {
  const rows = [...help];
  for (const entry of buildFleetVerbCatalog(Object.keys(FLEET_SUBCOMMAND_LOADERS), readVerbSource)) {
    const name = `fleet ${entry.verb}`;
    if (help.some(row => row.cmd === name || row.cmd.startsWith(`${name} `))) continue;
    const usage = entry.usage?.replace(/^(?:phm|ashlr|phantom)\s+/, '').split(/\\[rn]/)[0];
    rows.push({ cmd: usage === name || usage?.startsWith(`${name} `) ? usage : name,
      desc: entry.summary ?? NO_HELP_TEXT(name) });
  }
  return rows;
}

export async function cmdDocsCli(args: string[], rows: readonly CommandRow[], root = process.cwd()): Promise<number> {
  const json = args.includes('--json');
  const usage = 'usage: phm docs cli [--check] [--json]';
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${usage}\n\nRegenerate ${CLI_REFERENCE_PATH} from the command registry in the repository root.\n--check reports missing, removed or stale commands without writing.`);
    return 0;
  }
  const unknown = args.find(arg => arg !== '--check' && arg !== '--json');
  if (unknown) {
    const error = `Unknown argument "${unknown}". ${usage}`;
    if (json) console.log(JSON.stringify({ ok: false, error }));
    else console.error(error);
    return 2;
  }
  try {
    const report = await syncCliReference(rows, resolve(root, CLI_REFERENCE_PATH), args.includes('--check'));
    if (json) console.log(JSON.stringify(report, null, 2));
    else if (report.ok) console.log(`${CLI_REFERENCE_PATH}: ${report.updated ? 'updated' : 'up to date'} (${report.commands} entries).`);
    else {
      for (const kind of ['missing', 'removed', 'stale'] as const) {
        for (const command of report[kind]) console.log(`${kind}: phm ${command}`);
      }
      if (report.formatting) console.log(`stale: ${CLI_REFERENCE_PATH} formatting`);
    }
    return report.ok ? 0 : 1;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    if (json) console.log(JSON.stringify({ ok: false, error }));
    else console.error(error);
    return 1;
  }
}
