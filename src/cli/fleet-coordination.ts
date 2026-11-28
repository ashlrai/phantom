/** Local-only advisory ledger commands. No worker/dispatch imports belong here. */
import {
  claimFleetWork, handoffFleetClaim, postFleetMessage, proposeFleetAssignment,
  readFleetBoard, releaseFleetClaim,
} from '../core/fleet/coordination.js';

import { returnFleetClaim } from '../core/fleet/coordination-return.js';
import { parseCoordinationInboxFilters, projectCoordinationInbox, type CoordinationInboxFilters } from '../core/fleet/coordination-inbox.js';
import { parseCoordinationReturnsFilters, projectCoordinationReturns } from '../core/fleet/coordination-returns-view.js';
import { parseCoordinationBoardFilters, projectCoordinationBoard, type CoordinationBoardFilters } from '../core/fleet/coordination-board-view.js';
import { claimNoticeDir, claimNoticePaths } from '../core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding, validateClaimThreadKey } from '../core/fleet/claim-thread-binding-write.js';

const USAGE = 'Usage: ashlr fleet coordination <claim|release|return|returns|handoff|board|post|inbox|assign> [options]';
export const FLEET_COORDINATION_HELP = [
  USAGE,
  '  claim --repo owner/repo --task "work" --agent name [--ttl-seconds 3600] [--thread <slack:T:C:ts | T/C/ts>] [--json] — binds the claim\'s ASSIGNED/RELEASED/BLOCKED/VERIFIED notices to that thread; local state, not authority.',
  '  release <claim-id> --agent name --lease <lease> [--json]',
  '  return <claim-id> --agent name --lease <lease> (--pr n --head sha | --tests text | --artifact text | --blocked dependency) [--ttl-seconds 86400] [--json] — evidence, not authority; does not merge, verify or close anything; agent labels do not authenticate senders (the lease fences only release).',
  '  handoff <claim-id> --agent name --lease <lease> --to name [--ttl-seconds 3600] [--json]',
  '  board [--id <id>] [--from <label>] [--exclude-from <label>] [--to <label>] [--agent <label>] [--repo owner/name] [--since <15m|2h|1d|ISO|epoch>] [--before <when>] [--contains text] [--json] — the whole advisory board (claims, messages, proposals, expiredClaims) narrowed by the shared read filters, each applied only to the fields its collection records, so a row that never records the filtered field cannot match it: --id keeps rows whose own id strictly equals it; --from keeps only messages the named sender label wrote — claims and proposals record no sender and drop out; --exclude-from drops only that sender\'s messages while claims and proposals stay listed; --to keeps messages and proposals addressed to that exact label — claims record no recipient and drop out; --agent keeps only claims that label owns — messages and proposals record no claim owner and drop out; --repo keeps claims and proposals on that repo case-insensitively — messages record no repo and drop out; --since/--before keep rows inside one [since, before) window on their recorded stamp; --contains keeps rows whose displayed fields carry the text case-insensitively. Filters narrow the lists, never fabricate rows; an unreadable ledger still reports state unknown.',
  '  returns [--claim <id>] [--repo owner/name] [--result VERIFIED|BLOCKED] [--from name] [--since <15m|2h|1d|ISO|epoch>] [--before <when>] [--contains text] [--json] — RESULT receipts from coordination return, newest first; evidence, not authority. The filters narrow the parsed set before the newest-50 page, so a filtered read reaches receipts the unfiltered cap hides: --claim keeps one claim id\'s receipts, --repo one repo (case-insensitive), --result one verdict, --from one sender label, --since/--before keep receipts inside one [since, before) window on their at stamp, --contains keeps receipts whose repo, verdict, evidence kind or evidence text carries the text (case-insensitive).',
  '  post --from name --to name --message "text" [--id id] [--ttl-seconds 3600] [--json]',
  '  inbox --agent name [--from sender] [--since <15m|2h|1d|ISO|epoch>] [--before <when>] [--contains text] [--json] — filters narrow the addressed read: --from keeps posts one sender label wrote (proposals carry no sender and drop out), --since/--before keep records inside one [since, before) window on their at stamp, --contains keeps messages whose body and proposals whose repo+task carry the text (case-insensitive).',
  '  assign --repo owner/repo --task "work" --to name [--ttl-seconds 3600] [--json]',
  'Claims coordinate only. Assign proposes work and never spawns an agent.',
  'Keep the lease from claim/handoff private; it fences release and later handoffs.',
].join('\n');
const VALUES: Record<string, string[]> = {
  claim: ['--repo', '--task', '--agent', '--ttl-seconds', '--thread'], release: ['--agent', '--lease'],
  return: ['--agent', '--lease', '--pr', '--head', '--tests', '--artifact', '--blocked', '--ttl-seconds'],
  handoff: ['--agent', '--lease', '--to', '--ttl-seconds'],
  returns: ['--claim', '--repo', '--result', '--from', '--since', '--before', '--contains'],
  post: ['--from', '--to', '--message', '--id', '--ttl-seconds'], inbox: ['--agent', '--from', '--since', '--before', '--contains'],
  assign: ['--repo', '--task', '--to', '--ttl-seconds'],
  board: ['--id', '--from', '--exclude-from', '--to', '--agent', '--repo', '--since', '--before', '--contains'],
};
export async function cmdFleetCoordination(args: string[], deps: { runsRoot?: string; now?: () => number } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(FLEET_COORDINATION_HELP); return 0; }
  const [sub, ...rest] = args;
  const allowed = sub === undefined ? undefined : VALUES[sub];
  const values: Record<string, string> = {};
  const positional: string[] = [];
  const json = rest.includes('--json');
  const invalid = (): number => { console.error('Invalid fleet coordination arguments.\n' + FLEET_COORDINATION_HELP); return 2; };
  if (!allowed) return invalid();
  let jsonSeen = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') { if (jsonSeen) return invalid(); jsonSeen = true; continue; }
    if (allowed.includes(arg)) {
      const value = rest[++i];
      if (values[arg] !== undefined || !value || value.startsWith('--')) return invalid();
      values[arg] = value;
    } else if (arg.startsWith('-')) return invalid();
    else positional.push(arg);
  }
  if (positional.length !== ((sub === 'release' || sub === 'handoff' || sub === 'return') ? 1 : 0)) return invalid();
  const ttl = values['--ttl-seconds'];
  if (ttl !== undefined && !/^[1-9]\d{0,5}$/.test(ttl)) return invalid();
  const ttlMs = ttl === undefined ? undefined : Number(ttl) * 1000;
  const value = (name: string): string => values[`--${name}`] ?? '';
  const output = (result: unknown): void => {
    // Structured local output makes explicit unknown/error states visible in both modes.
    console.log(JSON.stringify(result, null, json ? undefined : 2));
  };
  if (sub === 'returns') {
    const now = (deps.now ?? Date.now)();
    const parsed = parseCoordinationReturnsFilters({ claim: values['--claim'], repo: values['--repo'],
      result: values['--result'], from: values['--from'], since: values['--since'],
      before: values['--before'], contains: values['--contains'] }, now);
    if (!parsed.ok) return invalid();
    const result = projectCoordinationReturns(readFleetBoard({ reap: false, now }), now, parsed.filters);
    output(result);
    return result.state === 'known' ? 0 : 1;
  }
  if (sub === 'board' || sub === 'inbox') {
    if (sub === 'inbox' && !value('agent')) return invalid();
    const now = (deps.now ?? Date.now)();
    let filters: CoordinationInboxFilters | CoordinationBoardFilters | undefined;
    if (sub === 'inbox') {
      const parsed = parseCoordinationInboxFilters({ from: values['--from'], since: values['--since'],
        before: values['--before'], contains: values['--contains'] }, now);
      if (!parsed.ok) return invalid();
      filters = parsed.filters;
    } else {
      const parsed = parseCoordinationBoardFilters({ id: values['--id'], from: values['--from'],
        excludeFrom: values['--exclude-from'], to: values['--to'], agent: values['--agent'],
        repo: values['--repo'], since: values['--since'], before: values['--before'],
        contains: values['--contains'] }, now);
      if (!parsed.ok) return invalid();
      filters = parsed.filters;
    }
    const board = readFleetBoard({ reap: false, now });
    output(sub === 'board' ? projectCoordinationBoard(board, filters as CoordinationBoardFilters | undefined)
      : projectCoordinationInbox(board, value('agent'), filters as CoordinationInboxFilters | undefined));
    return board.state === 'known' ? 0 : 1;
  }
  if (sub === 'return') {
    const result = returnFleetClaim({ id: positional[0]!, agent: value('agent'), lease: value('lease'),
      pr: values['--pr'], head: values['--head'], tests: values['--tests'], artifact: values['--artifact'], blocked: values['--blocked'], ttlMs });
    output(result);
    return result.ok ? 0 : result.outcome === 'invalid-input' ? 2 : 1;
  }
  const threadKey = values['--thread'];
  if (threadKey !== undefined && !validateClaimThreadKey(threadKey)) return invalid();
  if (sub === 'claim' && threadKey !== undefined) {
    const result = claimFleetWork({ repo: value('repo'), task: value('task'), agent: value('agent'), ttlMs });
    if (!result.ok) {
      output(result);
      return result.error === 'invalid-input' ? 2 : 1;
    }
    const { claim } = result.value;
    const binding = appendClaimThreadBinding(claimNoticePaths(claimNoticeDir(deps.runsRoot)).bindings,
      { claimId: claim.id, repo: claim.repo, threadKey }, (deps.now ?? Date.now)());
    output({ ...result, threadBinding: binding.ok
      ? { ok: true, status: binding.status } : { ok: false, reason: binding.reason } });
    return binding.ok ? 0 : 1;
  }
  const result = sub === 'claim' ? claimFleetWork({ repo: value('repo'), task: value('task'), agent: value('agent'), ttlMs })
    : sub === 'release' ? releaseFleetClaim({ id: positional[0]!, agent: value('agent'), lease: value('lease') })
      : sub === 'handoff' ? handoffFleetClaim({ id: positional[0]!, agent: value('agent'), lease: value('lease'), to: value('to'), ttlMs })
        : sub === 'post' ? postFleetMessage({ from: value('from'), to: value('to'), body: value('message'), id: values['--id'], ttlMs })
          : proposeFleetAssignment({ repo: value('repo'), task: value('task'), to: value('to'), ttlMs });
  output(result);
  return result.ok ? 0 : result.error === 'invalid-input' ? 2 : 1;
}
