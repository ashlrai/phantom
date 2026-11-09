/**
 * routes/verse/leader-thread/composer-commands.ts — the typed-command layer of
 * the Leader composer. Pure: a draft that starts with "/" and names a command
 * here is a command; everything else (an unknown "/word" included) stays a
 * normal inbox message, unchanged.
 */
export type ComposerCommandName = 'pause' | 'resume' | 'release' | 'stop' | 'drop' | 'help';

export interface ComposerCommandSpec {
  name: ComposerCommandName;
  usage: string;
  summary: string;
  /** The required argument's name, or null when the command takes none. */
  arg: string | null;
}

export const COMPOSER_COMMANDS: readonly ComposerCommandSpec[] = [
  { name: 'pause', usage: '/pause', summary: 'Pause the fleet (kill switch)', arg: null },
  { name: 'resume', usage: '/resume', summary: 'Resume the fleet', arg: null },
  { name: 'release', usage: '/release <lane>', summary: 'Release a lane hold', arg: 'lane' },
  { name: 'stop', usage: '/stop <job-id>', summary: 'Stop one running job', arg: 'job-id' },
  { name: 'drop', usage: '/drop <text>', summary: 'Open the drop-job sheet with this text', arg: 'text' },
  { name: 'help', usage: '/help', summary: 'List these commands', arg: null },
];

export type ParsedDraft = { kind: 'command'; name: ComposerCommandName; arg: string } | { kind: 'message' };

const COMMAND = /^\s*\/([A-Za-z]+)(?:\s+([\s\S]*))?$/;

export function commandSpec(name: ComposerCommandName): ComposerCommandSpec {
  return COMPOSER_COMMANDS.find(spec => spec.name === name)!;
}

export function parseComposerDraft(draft: string): ParsedDraft {
  const match = COMMAND.exec(draft);
  const name = match?.[1]!.toLowerCase();
  const spec = COMPOSER_COMMANDS.find(item => item.name === name);
  return spec ? { kind: 'command', name: spec.name, arg: (match![2] ?? '').trim() } : { kind: 'message' };
}

/** The line shown instead of running a command whose argument is missing or malformed. */
export function commandArgError(command: { name: ComposerCommandName; arg: string }): string | null {
  const spec = commandSpec(command.name);
  if (!spec.arg) return null;
  if (!command.arg) return `/${spec.name} needs a ${spec.arg}: ${spec.usage}`;
  // Same lane shape the Verse composer's /release accepts.
  if (spec.name === 'release' && !/^[a-z][a-z0-9-]{1,39}$/.test(command.arg)) {
    return 'Enter a valid lane name (2–40 lowercase letters, digits or hyphens).';
  }
  if (spec.name === 'stop' && /\s/.test(command.arg)) return `/stop takes one job id: ${spec.usage}`;
  return null;
}

/** Commands matching a draft that starts with "/": by name prefix while typing the name, the exact one after it. */
export function commandHints(draft: string): ComposerCommandSpec[] {
  const match = /^\s*\/([A-Za-z]*)(\s[\s\S]*)?$/.exec(draft);
  if (!match) return [];
  const typed = match[1]!.toLowerCase();
  return COMPOSER_COMMANDS.filter(spec => match[2] === undefined ? spec.name.startsWith(typed) : spec.name === typed);
}

/** Tab completion to the first hint, or null when there is nothing to complete. */
export function completeCommand(draft: string): string | null {
  if (!/^\s*\/[A-Za-z]*$/.test(draft)) return null;
  const first = commandHints(draft)[0];
  if (!first) return null;
  const next = `/${first.name}${first.arg ? ' ' : ''}`;
  return next === draft ? null : next;
}

export function helpLine(): string {
  return `Commands: ${COMPOSER_COMMANDS.map(spec => spec.usage).join(' · ')}. Anything else is sent to the Leader.`;
}
