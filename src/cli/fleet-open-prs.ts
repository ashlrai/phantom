import { resolve } from 'node:path';
import { runsRoot } from '../core/metrics/loop-collect.js';
import { OPEN_PRS_FILE, OPEN_PRS_REPO, refreshOpenPrs } from '../core/fleet/open-prs.js';

const mergeWords: Record<string, string> = { CLEAN: 'ready', DIRTY: 'conflicts', BEHIND: 'needs update', BLOCKED: 'blocked', UNSTABLE: 'checks need attention', DRAFT: 'draft', HAS_HOOKS: 'waiting for hooks' };
const USAGE = 'phm fleet open-prs --repo owner/name [--root PATH] [--json]\nRead open PRs from GitHub and save fleet/open-prs.json locally. Never changes GitHub.';
export async function cmdFleetOpenPrs(args: string[]): Promise<number> {
  let repo = '', root = runsRoot(), json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') { console.log(USAGE); return 0; }
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--repo' && !repo && OPEN_PRS_REPO.test(args[i + 1] ?? '')) repo = args[++i]!;
    else if (args[i] === '--root' && args[i + 1] && !args[i + 1]!.startsWith('-')) root = resolve(args[++i]!);
    else { console.error(USAGE); return 2; }
  }
  if (!repo) { console.error(USAGE); return 2; }
  try {
    const s = await refreshOpenPrs(root, repo);
    console.log(json ? JSON.stringify(s) : `Open PRs: ${s.total ?? 'unknown'} (${s.state === 'ready' ? 'fresh' : s.state === 'fallback' ? 'last known rows' : 'no PR data'}); saved ${OPEN_PRS_FILE}\n` +
      (s.items ?? []).map(p => `${p.repo} #${p.number}: ${mergeWords[p.mergeStateStatus] ?? 'unknown'}; age ${p.ageHours ?? 'unknown'} hours; job ${p.jobId ?? 'unknown'}`).join('\n'));
    return s.state === 'ready' ? 0 : 1;
  } catch { console.error('Open PR snapshot could not be saved.'); return 1; }
}
