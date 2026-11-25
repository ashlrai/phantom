import { isSlackChannelId, isSlackTs } from '../core/agents/slack-network.js';
import { readSlackRequestTrace, type SlackRequestTraceOptions } from '../core/agents/slack-request-trace.js';
import { slackTraceRowsToWorkItems, type SlackTraceClaim } from '../core/comms/slack-trace-work-items.js';
import { classifyWorkItem } from '../core/comms/work-item-state.js';
import { claimNoticeDir, claimNoticePaths, readClaimThreadBindings } from '../core/fleet/claim-notice-send.js';
import { readFleetBoard } from '../core/fleet/coordination.js';
import { scrubSecrets } from '../core/util/scrub.js';

const safeDisplay = (value: string): string => scrubSecrets(value).replace(/[\r\n\p{Cc}\p{Zl}\p{Zp}]/gu, ' ');

const usage = 'Usage: ashlr fleet slack-trace [--thread <ts>] [--channel <Slack channel id>] [--message <ts>] [--work-state] [--json]';

/**
 * Read-only per-request trace: ingress receipt to same-thread reply outcome.
 * Exit 0 requires both sources ok, at least one request, and every row both
 * `answered` and carrying durable bus ingress evidence (`ingress !== 'unknown'`,
 * the same join fleet slack-evidence enforces). `answered` is reply transport
 * evidence only; it never proves RUNNING/VERIFIED task execution. Output is
 * ids and timestamps only, never text, author ids or paths.
 * `--work-state` adds the reporting-contract state per row (RECEIVED unless a
 * live claim bound to the request's thread names an owner); read-only, and
 * without the flag the output is unchanged.
 */
/** Live board claims joined to their claim-thread bindings (read-only: no reap, no writes). */
export function readSlackTraceClaims(deps: {
  readBoard?: typeof readFleetBoard;
  readBindings?: () => ReturnType<typeof readClaimThreadBindings>;
} = {}): SlackTraceClaim[] {
  const board = (deps.readBoard ?? readFleetBoard)({ reap: false });
  if (board.state !== 'known') return [];
  const bindings = deps.readBindings?.() ?? readClaimThreadBindings(claimNoticePaths(claimNoticeDir()).bindings);
  return board.claims.flatMap((claim) => {
    return bindings.filter((b) => b.claimId === claim.id && b.repo === claim.repo)
      .map((bound) => ({ claimId: claim.id, repo: claim.repo, agent: claim.agent, threadKey: bound.threadKey }));
  });
}

export async function cmdFleetSlackTrace(
  args: string[],
  deps: SlackRequestTraceOptions & {
    readTrace?: typeof readSlackRequestTrace;
    readClaims?: () => readonly SlackTraceClaim[];
  } = {},
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${usage}\nTrace each ingested Slack request from its journal receipt to its reply outcome.`);
    return 0;
  }
  let json = false;
  let workState = false;
  let thread: string | undefined;
  let channelId: string | undefined;
  let message: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--work-state') {
      workState = true;
    } else if (arg === '--thread') {
      const value = args[++i];
      if (thread !== undefined || !isSlackTs(value)) {
        console.error(usage);
        return 2;
      }
      thread = value;
    } else if (arg === '--channel') {
      const value = args[++i];
      if (channelId !== undefined || !isSlackChannelId(value)) {
        console.error(usage);
        return 2;
      }
      channelId = value;
    } else if (arg === '--message') {
      const value = args[++i];
      if (message !== undefined || !isSlackTs(value)) {
        console.error(usage);
        return 2;
      }
      message = value;
    } else {
      console.error(usage);
      return 2;
    }
  }
  if (message !== undefined && (thread === undefined || channelId === undefined)) {
    console.error(usage);
    return 2;
  }
  const { readTrace = readSlackRequestTrace, readClaims = readSlackTraceClaims, ...readOptions } = deps;
  const selectedThread = thread ?? deps.thread;
  const scope = 'Bounded local persisted journal and send evidence only; does not prove current runtime reachability.';
  const collectionScope = {
    ...(selectedThread !== undefined ? { thread: selectedThread } : {}),
    ...(channelId !== undefined ? { channelId } : {}),
    ...(message !== undefined ? { messageTs: message } : {}),
  };
  let collected: ReturnType<typeof readSlackRequestTrace>;
  try {
    collected = readTrace({ ...readOptions, ...(thread !== undefined ? { thread } : {}) });
  } catch {
    // Fixed shape only: never echo the thrown value (may carry paths or message text).
    let asOf: string;
    try { asOf = (deps.now ?? (() => new Date()))().toISOString(); }
    catch { asOf = new Date(0).toISOString(); }
    const counts = { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 };
    const sources = { journal: 'degraded', sends: 'degraded' } as const;
    if (json) {
      console.log(JSON.stringify({ asOf, rows: [], counts, sources, sourceState: 'unavailable', scope, collectionScope }));
    } else {
      console.log(`slack trace evidence unavailable: persisted trace collection failed (journal=degraded sends=degraded) ` +
        `as of ${asOf} (collection time, not a runtime probe); ${scope} This is not a healthy no-match.`);
    }
    return 1;
  }
  const rows = collected.rows.filter((row) =>
    (channelId === undefined || row.channelId === channelId) && (message === undefined || row.messageTs === message));
  const counts = { total: rows.length, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 };
  for (const row of rows) {
    if (row.outcome === 'answered') counts.answered++;
    else if (row.outcome === 'uncertain') counts.uncertain++;
    else if (row.outcome === 'bus-failed') counts.busFailed++;
    else counts.unanswered++;
  }
  let outRows: Array<(typeof rows)[number] & { state?: string; stateAsOf?: string; stateMissing?: string[]; stateOwner?: string; stateSource?: string }> = rows;
  if (workState) {
    let claims: readonly SlackTraceClaim[] = [];
    // An unreadable claim store means no claim evidence: rows stay RECEIVED, never ASSIGNED.
    try { claims = readClaims(); } catch { claims = []; }
    const items = slackTraceRowsToWorkItems(rows, claims);
    outRows = rows.map((row, i) => {
      const item = items[i]!;
      const c = classifyWorkItem(item, collected.asOf);
      return { ...row, state: c.state, stateAsOf: c.asOf, stateMissing: c.missing,
        ...(c.state === 'ASSIGNED' && item.owner ? { stateOwner: safeDisplay(item.owner) } : {}),
        stateSource: safeDisplay(c.source) };
    });
  }
  const trace = { ...collected, rows: outRows, counts, scope, collectionScope };
  if (json) {
    console.log(JSON.stringify(trace));
  } else {
    console.log(`slack trace as of ${trace.asOf} (journal=${trace.sources.journal} sends=${trace.sources.sends}) ` +
      `scope: channel=${channelId ?? 'all'} thread=${selectedThread ?? 'all'}` +
      `${message !== undefined ? ` message=${message}` : ''}; ${scope}`);
    if (trace.rows.length === 0) console.log('No matching request evidence; verification unsuccessful.');
    for (const row of trace.rows) {
      console.log(`${row.at} ${row.channelId} thread=${row.threadTs} msg=${row.messageTs} ingress=${row.ingress} -> ` +
        `${row.outcome.toUpperCase()}${row.evidence === 'unverified' ? ' (reply identity unverified)' : ''}${row.replyTs !== undefined ? ` reply=${row.replyTs}` : ''}` +
        `${row.state !== undefined ? ` state=${row.state} owner=${row.stateOwner ?? 'unknown'} source=${row.stateSource} missing=${row.stateMissing?.length ? row.stateMissing.join(',') : 'none'}` : ''}`);
    }
  }
  const clean = trace.sources.journal === 'ok' && trace.sources.sends === 'ok';
  // An answered row whose ingress is unknown has reply evidence but no bus receipt for the request itself; refuse it.
  return clean && trace.rows.length > 0 &&
    trace.rows.every((row) => row.outcome === 'answered' && row.ingress !== 'unknown') ? 0 : 1;
}
