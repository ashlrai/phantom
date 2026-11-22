import { resolve } from 'node:path';
import { runsRoot } from '../core/metrics/loop-collect.js';
import { readReleaseBacklog } from '../core/release/backlog.js';
import { compactBriefLines, readCompactBrief, writeCompactBrief } from '../core/fleet/leader-compact-brief.js';

export async function cmdLeaderBrief(args: string[]): Promise<number> {
  const rest = [...args], json = rest.includes('--json');
  if (json) rest.splice(rest.indexOf('--json'), 1);
  const index = rest.indexOf('--write'), file = index >= 0 ? rest[index + 1] : undefined;
  if (index >= 0 && file && !file.startsWith('-')) rest.splice(index, 2);
  if (rest.length) { console.error('Usage: phm leader brief [--json] [--write <path>]'); return 2; }
  try {
    await readReleaseBacklog();
    const root = runsRoot();
    const brief = file ? await writeCompactBrief(root, Date.now(), resolve(file)) : await readCompactBrief(root);
    console.log(json ? JSON.stringify(brief) : compactBriefLines(brief).join('\n'));
    return 0;
  } catch { console.error('Leader brief could not be written.'); return 1; }
}
