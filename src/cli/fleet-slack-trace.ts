import { isSlackChannelId, isSlackTs } from '../core/agents/slack-network.js';
import { readSlackRequestTrace, type SlackRequestTraceOptions } from '../core/agents/slack-request-trace.js';
import { slackTraceRowsToWorkItems, type SlackTraceClaim } from '../core/comms/slack-trace-work-items.js';
import { classifyWorkItem } from '../core/comms/work-item-state.js';
import { claimNoticeDir, claimNoticePaths, readClaimThreadBindings, readClaimThreadBindingsState } from '../core/fleet/claim-notice-send.js';
import { readFleetBoard } from '../core/fleet/coordination.js';

const sameMessageTs = (a: unknown, b: unknown): boolean => {
  if (!isSlackTs(a) || !isSlackTs(b)) return false;
  const normalize = (ts: string) => ts.replace(/^0+(?=\d)/, '').replace(/0+$/, '');
  return normalize(a) === normalize(b);
};

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

type ClaimHealth = { board: 'ok' | 'unavailable'; bindings: 'ok' | 'unavailable' };

/** Read both ownership sources independently; failures never become empty evidence. */
export function readSlackTraceClaimsState(deps: {
  readBoard?: typeof readFleetBoard;
  readBindings?: () => ReturnType<typeof readClaimThreadBindingsState>;
} = {}): { claims: SlackTraceClaim[]; sources: ClaimHealth } {
  let board: ReturnType<typeof readFleetBoard> | undefined;
  let bindings: ReturnType<typeof readClaimThreadBindingsState> = null;
  try { board = (deps.readBoard ?? readFleetBoard)({ reap: false }); } catch { /* unavailable */ }
  try { bindings = (deps.readBindings ?? (() => readClaimThreadBindingsState(claimNoticePaths(claimNoticeDir()).bindings)))(); } catch { /* unavailable */ }
  const sources: ClaimHealth = { board: board?.state === 'known' ? 'ok' : 'unavailable', bindings: bindings === null ? 'unavailable' : 'ok' };
  const claims = board?.state === 'known' && bindings !== null
    ? board.claims.flatMap(claim => bindings!.filter(b => b.claimId === claim.id && b.repo === claim.repo)
      .map(bound => ({ claimId: claim.id, repo: claim.repo, agent: claim.agent, threadKey: bound.threadKey })))
    : [];
  return { claims, sources };
}

export async function cmdFleetSlackTrace(
  args: string[],
  deps: SlackRequestTraceOptions & {
    readTrace?: typeof readSlackRequestTrace;
    readClaims?: () => readonly SlackTraceClaim[];
    readClaimsState?: typeof readSlackTraceClaimsState;
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
  const { readTrace = readSlackRequestTrace, readClaims, readClaimsState = readSlackTraceClaimsState, ...readOptions } = deps;
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
    const claimSources = { board: 'unavailable', bindings: 'unavailable' } as const;
    if (json) {
      console.log(JSON.stringify({ asOf, rows: [], counts, sources, sourceState: 'unavailable', scope, collectionScope, ...(workState ? { claimSources } : {}) }));
    } else {
      console.log(`slack trace evidence unavailable: persisted trace collection failed (journal=degraded sends=degraded) ` +
        `as of ${asOf} (collection time, not a runtime probe); ${scope} This is not a healthy no-match.` +
        (workState ? ' ownership sources: board=unavailable bindings=unavailable' : ''));
    }
    return 1;
  }
  const rows = collected.rows.filter((row) =>
    (channelId === undefined || row.channelId === channelId) && (message === undefined || sameMessageTs(row.messageTs, message)));
  const counts = { total: rows.length, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 };
  for (const row of rows) {
    if (row.outcome === 'answered') counts.answered++;
    else if (row.outcome === 'uncertain') counts.uncertain++;
    else if (row.outcome === 'bus-failed') counts.busFailed++;
    else counts.unanswered++;
  }
  let outRows: Array<(typeof rows)[number] & { state?: string; stateAsOf?: string; stateMissing?: string[] }> = rows;
  let claimSources: ClaimHealth | undefined;
  if (workState) {
    let claims: readonly SlackTraceClaim[] = [];
    try {
      if (readClaims) {
        claims = readClaims();
        claimSources = { board: 'ok', bindings: 'ok' };
      } else {
        const result = readClaimsState();
        claims = result.claims;
        claimSources = result.sources;
      }
    } catch { claimSources = { board: 'unavailable', bindings: 'unavailable' }; }
    const unavailable = Object.entries(claimSources).filter(([, state]) => state !== 'ok').map(([source]) => `ownership source unavailable: ${source}`);
    const items = slackTraceRowsToWorkItems(rows, claims);
    outRows = rows.map((row, i) => {
      const c = classifyWorkItem(items[i]!, collected.asOf);
      return { ...row, state: c.state, stateAsOf: c.asOf, stateMissing: [...c.missing, ...unavailable] };
    });
  }
  const trace = { ...collected, rows: outRows, counts, scope, collectionScope, ...(claimSources ? { claimSources } : {}) };
  if (json) {
    console.log(JSON.stringify(trace));
  } else {
    console.log(`slack trace as of ${trace.asOf} (journal=${trace.sources.journal} sends=${trace.sources.sends}) ` +
      `scope: channel=${channelId ?? 'all'} thread=${selectedThread ?? 'all'}` +
      `${message !== undefined ? ` message=${message}` : ''}; ${scope}`);
    if (claimSources) console.log(`ownership sources: board=${claimSources.board} bindings=${claimSources.bindings}`);
    if (trace.rows.length === 0) console.log('No matching request evidence; verification unsuccessful.');
    for (const row of trace.rows) {
      console.log(`${row.at} ${row.channelId} thread=${row.threadTs} msg=${row.messageTs} ingress=${row.ingress} -> ` +
        `${row.outcome.toUpperCase()}${row.evidence === 'unverified' ? ' (reply identity unverified)' : ''}${row.replyTs !== undefined ? ` reply=${row.replyTs}` : ''}` +
        `${row.state !== undefined ? ` state=${row.state} missing=${row.stateMissing?.length ? row.stateMissing.join(',') : 'none'}` : ''}`);
    }
  }
  const clean = trace.sources.journal === 'ok' && trace.sources.sends === 'ok';
  // An answered row whose ingress is unknown has reply evidence but no bus receipt for the request itself; refuse it.
  return clean && (!workState || (claimSources?.board === 'ok' && claimSources.bindings === 'ok')) && trace.rows.length > 0 &&
    trace.rows.every((row) => row.outcome === 'answered' && row.ingress !== 'unknown') ? 0 : 1;
}
