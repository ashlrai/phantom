/**
 * `phm router regret` writes a local JSON backlog. It does not open GitHub
 * issues or comments. The posting flag cannot be turned on.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadSchedulerConfig } from '../core/providers/coding-cli/scheduler/defaults.js';
import { emptyBandit, updateBandit } from '../core/providers/coding-cli/scheduler/learn.js';
import { computeRegret, readOutcomes, regretBacklog, writeRegretBacklog } from '../core/providers/coding-cli/scheduler/regret.js';
import type { BanditState } from '../core/providers/coding-cli/scheduler/types.js';

const USAGE = [
  'usage:',
  '  phm router regret [--ledger <outcomes.jsonl>] [--bandit <state.json>] [--backlog <out.json>] [--json]',
  '  Posting to GitHub is off. --post and --post-issues do not create issues or comments.',
];

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

function routerDir(): string {
  const home = process.env['ASHLR_HOME'] ?? join(homedir(), '.ashlr');
  return join(home, 'router');
}

function readBandit(path: string | undefined): BanditState {
  if (!path) return emptyBandit();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return emptyBandit();
    const row = raw as { id?: unknown; arms?: unknown };
    if (typeof row.arms !== 'object' || row.arms === null) return emptyBandit();
    return { id: typeof row.id === 'string' ? row.id : 'incumbent', arms: row.arms as BanditState['arms'] };
  } catch {
    return emptyBandit();
  }
}

export async function runRouterCli(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === 'help' || args.includes('--help') || args.includes('-h') || sub === undefined) {
    for (const line of USAGE) console.log(line);
    return sub === undefined ? 1 : 0;
  }
  if (sub !== 'regret') {
    console.error(`unknown router subcommand: ${sub}`);
    for (const line of USAGE) console.error(line);
    return 1;
  }
  if (args.includes('--post') || args.includes('--post-issues')) {
    console.error('router regret does not post to GitHub. The posting flag stays off.');
  }
  const ledgerPath = flagValue(args, '--ledger') ?? join(routerDir(), 'outcomes.jsonl');
  const banditPath = flagValue(args, '--bandit');
  const backlogPath = flagValue(args, '--backlog') ?? join(routerDir(), 'regret-backlog.json');
  let text = '';
  try {
    text = readFileSync(ledgerPath, 'utf8');
  } catch {
    text = '';
  }
  const outcomes = readOutcomes(text);
  let bandit = readBandit(banditPath);
  for (const outcome of outcomes) bandit = updateBandit(bandit, outcome);
  const config = loadSchedulerConfig();
  const items = computeRegret({ outcomes, bandit, config });
  const generatedAt = new Date().toISOString();
  const backlog = regretBacklog(items, generatedAt);
  writeRegretBacklog(backlogPath, backlog);
  if (args.includes('--json')) console.log(JSON.stringify(backlog));
  else console.log(`router regret: ${items.length} item${items.length === 1 ? '' : 's'} in ${backlogPath}. posting is off.`);
  return 0;
}
