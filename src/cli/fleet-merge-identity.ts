/**
 * `ashlr fleet merge-identity` - count merges by actor class (automation vs
 * human). Read-only; see docs/MERGE-IDENTITY.md.
 *
 * Recovered from #4225 (`phm prs merges`, RQ-HS-MERGE-IDENTITY-DESIGN) as a
 * fleet subcommand: same flags, exit codes and output contract.
 */
import { assertRepo, defaultGh, type Gh } from '../core/autopilot/github.js';
import { readMerges, summarizeMerges } from '../core/prs/merge-identity.js';

const USAGE = `Usage: ashlr fleet merge-identity --since <ISO> [--until <ISO>] [--repo <owner/name>] [--automation-login <login>]... [--json]
Count merged PRs in a window by actor class: automation (a Bot, or a login you name), human, or unknown.
A merge queue merge is credited to whoever enqueued it. Read-only; see docs/MERGE-IDENTITY.md.`;

function isoOrNull(value: string | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}

export async function cmdFleetMergeIdentity(args: string[], deps: { gh?: Gh } = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  let since: string | undefined, until: string | undefined, repo: string | undefined, json = false;
  const automationLogins: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!, value = args[i + 1];
    const takesValue = ['--since', '--until', '--repo', '--automation-login'].includes(flag);
    if (flag === '--json' && !json) json = true;
    else if (takesValue && value && !value.startsWith('-')) {
      i++;
      if (flag === '--since' && !since) since = value;
      else if (flag === '--until' && !until) until = value;
      else if (flag === '--repo' && !repo) repo = value;
      else if (flag === '--automation-login') automationLogins.push(value);
      else { console.error(USAGE); return 2; }
    } else { console.error(USAGE); return 2; }
  }
  const sinceIso = isoOrNull(since);
  const untilIso = until === undefined ? undefined : isoOrNull(until);
  if (!sinceIso || untilIso === null) { console.error(`error: --since and --until take an ISO 8601 date or timestamp.\n${USAGE}`); return 2; }
  const gh = deps.gh ?? defaultGh;
  try {
    const slug = assertRepo(repo ?? (JSON.parse(await gh(['repo', 'view', '--json', 'nameWithOwner'])) as { nameWithOwner: string }).nameWithOwner);
    const { records, truncated } = await readMerges(slug, sinceIso, { ...(untilIso ? { until: untilIso } : {}), gh });
    const summary = summarizeMerges(records, { repo: slug, since: sinceIso, ...(untilIso ? { until: untilIso } : {}), automationLogins, truncated });
    if (json) console.log(JSON.stringify(summary));
    else {
      const { counts } = summary;
      console.log(`${summary.repo}: ${summary.total} merged since ${sinceIso}: ${counts.automation} automation, ${counts.human} human, ${counts.unknown} unknown.`);
      for (const row of summary.actors) console.log(`  ${row.login}\t${row.class}\t${row.count}`);
      if (summary.truncated) console.log('Search hit its page cap; narrow the window for a full count.');
    }
    return 0;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : 'unable to read merges'}`);
    return 1;
  }
}
