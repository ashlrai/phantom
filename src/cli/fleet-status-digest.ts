import { homedir } from 'node:os';
import { join } from 'node:path';
import { composeOwnerStatusReply } from '../core/agents/owner-status-reply.js';
import { gatherStatusDigestInput, type StatusDigestSources } from '../core/leader/status-digest-sources.js';
import { buildStatusDigest } from '../core/leader/status-digest.js';

const usage = 'Usage: ashlr fleet status-digest [--json] [--runs-dir <path>]';

export async function cmdFleetStatusDigest(args: string[], deps: { now?: () => Date; sources?: Partial<StatusDigestSources> } = {}): Promise<number> {
  let json = false;
  let runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--runs-dir' && runsDir === undefined && next && !next.startsWith('-')) { runsDir = next; i++; }
    else { console.error(usage); return 2; }
  }
  const root = runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const now = (deps.now ?? (() => new Date()))();
  if (json) {
    const facts = await gatherStatusDigestInput(root, now, deps.sources);
    console.log(JSON.stringify({ schema: 'phantom.status-digest.v1', at: now.toISOString(), lines: buildStatusDigest(facts), facts }));
  } else {
    const brief = deps.sources ? async (dir: string, at: Date): Promise<string> =>
      ['Morning leader brief', ...buildStatusDigest(await gatherStatusDigestInput(dir, at, deps.sources))].join('\n') : undefined;
    console.log(await composeOwnerStatusReply(root, now, { brief }));
  }
  return 0;
}
