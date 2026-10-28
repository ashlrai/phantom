import { probeMergePath } from '../core/merge-path.js';

const usage = 'Usage: phm doctor merge-path --repo owner/name [--repo owner/name ...] [--branch branch] [--json]';
export async function cmdDoctorMergePath(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const repos: string[] = [];
  let branch: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if ((arg === '--repo' || arg === '--branch') && args[i + 1] && !args[i + 1]!.startsWith('--')) {
      const value = args[++i]!;
      if (arg === '--repo') repos.push(value); else branch = value;
    } else { console.error(usage); return 2; }
  }
  if (!repos.length) { console.error(usage); return 2; }
  try {
    const results = await Promise.all([...new Set(repos)].map(repo => probeMergePath(repo, branch)));
    if (json) console.log(JSON.stringify({ results }, null, 2));
    else for (const result of results) console.log(`${result.repo} ${result.branch}: ${result.signal}${result.missingContexts.length ? ` (${result.missingContexts.join(', ')})` : ''}`);
    return results.some(result => result.signal !== 'MERGE_PATH_OK') ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Merge path probe failed');
    return 1;
  }
}
