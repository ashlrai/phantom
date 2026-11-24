import { readFile, writeFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import type { CommandRow } from './catalog.js';

export const CLI_REFERENCE_PATH = 'docs/CLI-REFERENCE.md';

export interface CliReferenceReport {
  schema: 'phantom.cli-reference.v1';
  ok: boolean;
  check: boolean;
  path: string;
  commands: number;
  updated: boolean;
  missing: string[];
  removed: string[];
  stale: string[];
  formatting: boolean;
}

/** Placeholder the generator writes when a fleet verb's source has no one-line help. */
export const NO_HELP_TEXT = (verb: string): string => `Summary not registered; run phm ${verb} --help for details.`;
/** The command groups whose every verb must appear on the page, with a JSON form. */
export const VERB_GROUPS = ['fleet', 'leader', 'host'] as const;
export interface RegisteredVerb { group: string; verb: string; cmd: string; help: boolean }

/** Each verb named by a registered usage: `leader say|thread [--json]` names say and thread. */
export function registeredVerbs(rows: readonly CommandRow[]): RegisteredVerb[] {
  const result: RegisteredVerb[] = [];
  for (const { cmd, desc } of rows) {
    const [group, name] = clean(cmd).split(' ');
    if (!VERB_GROUPS.includes(group as never) || !name) continue;
    for (const verb of name.split('|')) {
      if (/^[a-z][a-z0-9-]*$/.test(verb)) result.push({ group: group!, verb, cmd, help: !desc.startsWith('Summary not registered') });
    }
  }
  return result;
}

/** Registered verbs in the three groups that have no row on the page; one plain line each. */
export function verbsMissingFromReference(rows: readonly CommandRow[], page: string): string[] {
  const documented = new Set<string>();
  for (const match of page.matchAll(/^\| <code>phm (.*?)<\/code> \|/gm)) {
    for (const entry of registeredVerbs([{ cmd: decode(match[1]!), desc: '' }])) documented.add(`${entry.group} ${entry.verb}`);
  }
  return [...new Set(registeredVerbs(rows).map(entry => `${entry.group} ${entry.verb}`))].filter(name => !documented.has(name))
    .sort().map(name => `phm ${name} is a registered command but is missing from ${CLI_REFERENCE_PATH}. Run: phm docs cli`);
}

const clean = (text: string): string => stripVTControlCharacters(text).replace(/\s+/g, ' ').replace(/\u2014/g, '-').trim();
const cell = (text: string): string => clean(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/`/g, '&#96;');
const code = (text: string): string => `<code>${cell(text)}</code>`;
const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#124;': '|', '&#96;': '`' };
const decode = (text: string): string => text.replace(/&(amp|lt|gt|#124|#96);/g, entity => entities[entity]!);

/** Keep the registry's usage grammar: do not invent arguments or JSON payloads. */
export function renderCliReference(rows: readonly CommandRow[]): string {
  const lines = rows.map(({ cmd, desc }) => {
    const flags = [...new Set(cmd.match(/--[a-z][a-z0-9-]*\b|(?<=\s|\[)-[a-zA-Z]\b/g) ?? [])].sort();
    const grouped = VERB_GROUPS.includes(clean(cmd).split(' ')[0] as never);
    const example = flags.includes('--json') ? code(`phm ${cmd.replace(/\[--json(?:\s*\|\s*--text)?\]/g, '--json')}`) : grouped ? 'unknown (not in the registered usage)' : '-';
    return `| ${code(`phm ${cmd}`)} | ${cell(desc)} | ${flags.map(code).join(', ') || '-'} | ${example} |`;
  }).sort();
  const missing = registeredVerbs(rows).filter(entry => !entry.help)
    .filter((entry, index, all) => all.findIndex(other => other.group === entry.group && other.verb === entry.verb) === index)
    .sort((a, b) => `${a.group} ${a.verb}`.localeCompare(`${b.group} ${b.verb}`));
  return [
    '# CLI reference', '',
    'Generated from `HELP_ENTRIES` in `src/cli/help.ts` (the `phm commands` catalog) and `FLEET_SUBCOMMAND_LOADERS`, using the metadata reader behind `phm fleet verbs`. Do not edit by hand.', '',
    'From the repository root, run `phm docs cli` to regenerate or `phm docs cli --check` to check without writing. Add `--json` for a structured report.',
    'From source: `npm run dev -- docs cli`. The existing `node --import tsx scripts/generate-cli-reference.ts` entry point uses the same generator.', '',
    'Each row preserves one registered usage and its summary. Flags come from that usage. JSON examples use the same notation: replace `<placeholders>`, choose `a|b` alternatives, and omit optional `[arguments]` as needed. Examples are not executed.',
    'Missing fleet summaries are marked explicitly; flags hidden behind `[opts]` or unavailable usage metadata require `phm <command> --help`. This describes the checkout; an installed older binary may differ.', '',
    '| Command | Summary | Flags | JSON example |',
    '| --- | --- | --- | --- |',
    ...lines, '',
    '## Fleet, leader and host verbs without help text', '',
    'These registered verbs have no one-line help in their source yet. Their rows above say so; the gap is shown, not guessed.', '',
    ...(missing.length ? missing.map(entry => `- <code>phm ${entry.group} ${entry.verb}</code>`) : ['None.']), '',
  ].join('\n');
}

/** Compare whole rows, including duplicate usage forms, without hiding prose drift. */
export function checkCliReference(rows: readonly CommandRow[], actual: string) {
  const expected = renderCliReference(rows);
  const entries = (page: string): Map<string, string> => {
    const result = new Map<string, string>();
    for (const match of page.matchAll(/^\| <code>phm (.*?)<\/code> \|.*$/gm)) {
      const name = decode(match[1]!);
      result.set(name, `${result.get(name) ?? ''}${match[0]}\n`);
    }
    return result;
  };
  const before = entries(actual);
  const after = entries(expected);
  const missing = [...after.keys()].filter(name => !before.has(name)).sort();
  const removed = [...before.keys()].filter(name => !after.has(name)).sort();
  const stale = [...after.keys()].filter(name => before.has(name) && before.get(name) !== after.get(name)).sort();
  return { ok: actual === expected, missing, removed, stale,
    formatting: actual !== expected && !missing.length && !removed.length && !stale.length };
}

export async function syncCliReference(rows: readonly CommandRow[], path: string, check = false): Promise<CliReferenceReport> {
  let actual = '';
  try { actual = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const diff = checkCliReference(rows, actual);
  const updated = !check && !diff.ok;
  if (updated) await writeFile(path, renderCliReference(rows), 'utf8');
  return { ...diff, schema: 'phantom.cli-reference.v1', ok: !check || diff.ok, check,
    path, commands: rows.length, updated };
}
