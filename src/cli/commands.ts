/**
 * cli/commands.ts — `phm commands [--json]`: every user-facing command with
 * its description, arguments and whether it changes state. Read-only. The
 * desktop palette (Cmd+K) lists the same catalog. Exit 0, or 2 for bad usage.
 */
import { buildCommandCatalog, commandLine, COMMANDS_SCHEMA } from '../core/commands/catalog.js';
import { HELP_ENTRIES } from './help.js';
import { pad } from './ui.js';

export async function cmdCommands(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: phm commands [--json]\n\nList every command: name, what it does, arguments and whether it changes state.');
    return 0;
  }
  const unknown = args.find((arg) => arg !== '--json');
  if (unknown) {
    console.error(`Unknown argument "${unknown}". usage: phm commands [--json]`);
    return 2;
  }
  const commands = buildCommandCatalog(HELP_ENTRIES);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ schema: COMMANDS_SCHEMA, commands }, null, 2));
    return 0;
  }
  const width = Math.max(...commands.map((command) => command.name.length));
  for (const command of commands) {
    console.log(`${pad(command.name, width)}  ${command.changesState ? 'changes state' : 'read-only    '}  ${command.description}`);
    for (const form of command.arguments) if (form) console.log(`${pad('', width)}  ${commandLine({ ...command, arguments: [form], needsInput: true })}`);
  }
  return 0;
}
