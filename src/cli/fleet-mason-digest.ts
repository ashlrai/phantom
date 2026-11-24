/** Owner's hourly update in six lines; --post records it in the local desktop thread. */
import { rejectUnknownOptions } from './args.js';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings } from '../core/comms/owner-channel.js';
import { masonDigestText, postMasonDigest, readMasonDigest, type MasonDigestPostOptions, type MasonDigestReaders } from '../core/comms/mason-digest.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import { THROUGHPUT_MAX_HOURS } from '../core/fleet/throughput.js';

const usage = 'Usage: phm fleet mason-digest [--since 1h] [--post] [--json]\n'
  + 'Summarize merges, releases, lanes, pools, wasted launches and owner asks in six lines. '
  + '--post records the digest in the local owner thread, at most once an hour; no channel transport is called.';

export interface MasonDigestCliDeps {
  now?: number;
  runsDir?: string;
  readers?: Partial<MasonDigestReaders>;
  post?: MasonDigestPostOptions['post'];
}

export async function cmdFleetMasonDigest(args: string[], deps: MasonDigestCliDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const bad = rejectUnknownOptions(args, { flags: ['--json', '--post'], values: ['--since'] });
  if (bad) { console.error(bad.message); console.error(usage); return 2; }
  const at = args.indexOf('--since');
  const now = deps.now ?? Date.now();
  const sinceMs = parseSince(at < 0 ? '1h' : args[at + 1] ?? '', now);
  if (sinceMs === null || !(sinceMs < now) || (now - sinceMs) / 3_600_000 > THROUGHPUT_MAX_HOURS) {
    console.error(`--since must be in the past and within ${THROUGHPUT_MAX_HOURS} hours (for example 1h or 6h).`);
    console.error(usage); return 2;
  }
  const runsDir = deps.runsDir ?? fixedOwnerRunsDir();
  const report = await readMasonDigest({ runsDir, now, sinceMs, readers: deps.readers });
  const post = args.includes('--post') ? await postMasonDigest(report, {
    runsDir, now, force: true, post: deps.post,
    owner: { runsDir, now: () => now, settings: loadOwnerThreadSettings(fixedOwnerConfigDir()) },
  }) : null;
  console.log(args.includes('--json') ? JSON.stringify({ ...report, post }) : [masonDigestText(report), ...(post ? [post.reason] : [])].join('\n'));
  return post && (post.state === 'unavailable' || post.state === 'refused') ? 1 : 0;
}
