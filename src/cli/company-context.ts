import { parseArgs } from 'node:util';
import { contextSection, readCompanyContext, writeCompanyContext } from '../core/context/company-context-store.js';

export function cmdCompanyContext(args: string[]): void {
  const [verb, ...rest] = args;
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Usage: phm context read [--section NAME] [--max-tokens N] [--json]\n       phm context write --section NAME --text TEXT --source SOURCE [--id ID] [--expires ISO] [--json]\nSections: decisions, priorities, clients, people, fleet-state. Read never writes; --help takes no action.');
    return;
  }
  const { values } = parseArgs({ args: rest, options: {
    section: { type: 'string' }, text: { type: 'string' }, source: { type: 'string' },
    id: { type: 'string' }, expires: { type: 'string' }, 'max-tokens': { type: 'string' }, json: { type: 'boolean' },
  } });
  if (verb !== 'read' && verb !== 'write') throw new Error('Use phm context read [--section NAME] or write --section NAME --text TEXT --source SOURCE.');
  const section = values.section === undefined ? undefined : contextSection(values.section);
  if (verb === 'read' && (values.text || values.source || values.id || values.expires)) throw new Error('Write options require context write.');
  if (verb === 'write' && (!section || !values.text || !values.source || values['max-tokens'])) throw new Error('Write requires --section, --text, and --source.');
  const result = verb === 'read'
    ? readCompanyContext({ section, maxTokens: values['max-tokens'] === undefined ? undefined : Number(values['max-tokens']) })
    : writeCompanyContext({ section: section!, text: values.text!, source: values.source!, id: values.id,
      expiresAt: values.expires === undefined ? undefined : Date.parse(values.expires) });
  console.log(values.json ? JSON.stringify(result) : 'digest' in result ? result.digest || 'No current context.' : result.appended ? 'Context saved.' : 'Context already saved.');
}
