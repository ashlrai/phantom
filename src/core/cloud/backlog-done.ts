/**
 * Checks a backlog item's `doneWhen` acceptance condition (a file on the
 * target repo's default branch, or an issue's state) through GitHub (the same bounded, non-prompting gh the
 * tracker uses). Only a positive read skips an item: a missing file is "open",
 * and any other failure is "unknown", which launches the item as before.
 */
import type { CloudBacklogItem } from './types.js';
import { defaultCloudGh } from './tracker.js';

export type DoneCheck = 'satisfied' | 'open' | 'unknown';
export type DoneChecker = (item: CloudBacklogItem, repo: string) => Promise<DoneCheck>;
type Gh = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export async function checkDoneWhen(item: CloudBacklogItem, repo: string, gh: Gh = defaultCloudGh): Promise<DoneCheck> {
  const done = item.doneWhen;
  if (!done) return 'open';
  try {
    if ('issue' in done) {
      const res = await gh(['api', `repos/${repo}/issues/${done.issue}`, '--jq', '.state']);
      if (!res.ok) return 'unknown';
      const state = res.stdout.trim();
      return state === 'closed' ? 'satisfied' : state === 'open' ? 'open' : 'unknown';
    }
    const res = await gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${done.path}`]);
    if (!res.ok) return /HTTP 404|Not Found/i.test(res.stderr) ? 'open' : 'unknown';
    return done.contains === undefined || res.stdout.includes(done.contains) ? 'satisfied' : 'open';
  } catch {
    return 'unknown';
  }
}
