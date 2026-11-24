/**
 * core/commands/catalog.ts — the one typed command list behind `phm commands`
 * and the desktop palette's Commands group.
 *
 * It is DERIVED from the CLI help table (src/cli/help.ts HELP_ENTRIES, which
 * test/cli-registry-drift.test.ts already pins to the dispatch switch), so
 * there is no second registry: a help row is a catalog command. The only fact
 * added here is which commands are read-only. Unlisted means "changes state":
 * a command nobody classified asks for confirmation instead of running.
 */

export interface CommandRow { cmd: string; desc: string }

export interface CatalogCommand {
  /** The literal words after `phm`, e.g. `fleet status`. Unique. */
  name: string;
  description: string;
  /** One entry per documented form; '' is the bare command. */
  arguments: string[];
  changesState: boolean;
  /** True when no documented form runs without arguments. */
  needsInput: boolean;
}

export const COMMANDS_SCHEMA = 'phantom.commands.v1';

/** Commands whose every documented form only reads. test/commands-catalog.test.ts fails on a stale name. */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'admission explain', 'agents bus contract', 'agents mesh status', 'agents roster', 'app update status', 'approvals', 'audit', 'authority status',
  'budget get', 'chain verify', 'ci reruns', 'commands', 'companions', 'config effective', 'config path', 'constitution check',
  'daemon activation-preflight', 'daemon service-status', 'disk', 'doctor merge-path', 'ecosystem doctor', 'empties', 'enroll list',
  'estates', 'feed', 'fleet direction', 'fleet evidence doctor', 'fleet status', 'fleet vitals', 'gh', 'goals', 'goals status',
  'graph', 'graph status', 'growth', 'help', 'home', 'host load', 'inbox show', 'jobs empty', 'knowledge graph', 'knowledge impact', 'lanes',
  'lanes fit', 'library', 'log', 'ls', 'map', 'mcp list', 'metrics idle', 'metrics levers', 'metrics merges', 'models', 'models check', 'nodes',

  'observe', 'observe session', 'orient', 'pages list', 'publish orphans', 'pool admission', 'pool runway', 'preflight', 'prs triage', 'pulse-test', 'queue batches', 'recut check', 'recut plan',
  'recut prompt',
  'reflect', 'release status', 'resources', 'route explain', 'router rank', 'router-calibration', 'run show', 'runs',
  'sandbox diff', 'sandbox list', 'seams', 'self drift', 'signals', 'skills audit', 'skills list', 'spec list', 'spec show', 'spend', 'status',
  'swarm show', 'swarms', 'throughput', 'tools requires', 'top', 'universe compare', 'universe graph', 'usage history', 'vercel',
  'verify-safety', 'version', 'wire status', 'world get', 'worklog', 'worktrees report',
]);

const NAME = /^[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)*(?=\s|$)/;

/** Help rows → one command per name, in help order. Rows sharing a name become its argument forms. */
export function buildCommandCatalog(rows: readonly CommandRow[]): CatalogCommand[] {
  const byName = new Map<string, CatalogCommand>();
  for (const row of rows) {
    const lead = NAME.exec(row.cmd)?.[0];
    if (!lead) continue;
    const name = lead.replace(/\s+/g, ' ');
    const form = row.cmd.slice(lead.length).trim();
    // A help row can include another command form after a pipe.
    // An optional-only alternative still allows this command to run bare.
    const bare = form.replace(/\[[^\]]*\]/g, '').split('|').some(part => part.trim() === '');
    const known = byName.get(name);
    if (known) {
      if (!known.arguments.includes(form)) known.arguments.push(form);
      known.needsInput &&= !bare;
    } else {
      byName.set(name, { name, description: row.desc, arguments: [form], changesState: !READ_ONLY_COMMANDS.has(name), needsInput: !bare });
    }
  }
  return [...byName.values()];
}

/** The line a person types: the bare command when it runs bare, else its first form. */
export function commandLine(command: CatalogCommand): string {
  const form = command.needsInput ? command.arguments[0] ?? '' : '';
  return `phm ${command.name}${form ? ` ${form}` : ''}`;
}
