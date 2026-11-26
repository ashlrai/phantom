import { basename, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { loadConfigReadOnly } from '../core/config.js';
import { localMerges, readRank, updateRank } from '../core/fleet/repo-rank.js';
import { canonicalMarketRepo, isRepoPriority, setRepoPriority } from '../core/fleet/repo-market.js';
import { listManagedRepos, planRepoChange } from '../core/fleet/repos-manager.js';

export async function cmdReposRank(args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  const json = rest.includes('--json');
  const [repo, value, extra] = rest.filter(arg => arg !== '--json');
  const emit = (result: unknown) => console.log(JSON.stringify(result, null, 2));
  if (verb === 'list' && repo === undefined) {
    const result = await listManagedRepos();
    if (json) emit(result);
    else {
      console.log('Priority: local only (not synced)');
      console.table(result.repos.map(({ repo, enrolled, grantStage, priority, queueDepth, allocation }) => ({
        repo, enrolled, grantStage, priority, queueDepth, share: `${(allocation.share * 100).toFixed(1)}%`,
      })));
    }
    return 0;
  }
  if (repo && extra === undefined) {
    const name = canonicalMarketRepo(repo);
    if (name && ((verb === 'add' || verb === 'remove') && value === undefined
      || verb === 'stage' && (value === 'propose' || value === 'merge'))) {
      const result = planRepoChange(name, verb === 'stage' ? value as 'propose' | 'merge' : verb as 'add' | 'remove');
      if (json) emit(result);
      else console.log(`${result.message}\nPreview: ${result.command.join(' ')}`);
      return 0;
    }
    if (name && verb === 'priority' && isRepoPriority(value)) {
      setRepoPriority(name, value);
      if (json) emit({ repo: name, priority: value, prioritySync: 'local-only' });
      else console.log(`${name}: ${value} (not synced)`);
      return 0;
    }
  }
  if (verb === 'proposals' && repo === undefined) {
    emit(readRank()?.proposals ?? []);
    return 0;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: phm repos rank [proposals] [--json] [--recompute]');
    return 0;
  }
  if (args[0] !== 'rank' || args.slice(1).some(a => !['proposals', '--json', '--recompute'].includes(a))) {
    console.error('Usage: phm repos list | add <repo> | remove <repo> | stage <repo> <propose|merge> | priority <repo> <boost|normal|pause> | rank [proposals] [--recompute] [--json]');
    return 2;
  }
  const proposals = args.includes('proposals');
  const state = proposals ? readRank() : updateRank(() => {
    const repositories = loadConfigReadOnly().roots.flatMap(root => {
      try { return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => ({ repo: basename(e.name), path: join(root, e.name) })); } catch { return []; }
    });
    return localMerges(repositories);
  }, { recompute: args.includes('--recompute') });
  const result = proposals ? state?.proposals ?? [] : state;
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (proposals) console.log(JSON.stringify(result, null, 2));
  else console.log(state?.rankings.map((r, i) => `${i + 1}. ${r.repo} ${(100 * r.weight).toFixed(1)}%`).join('\n'));
  return 0;
}
