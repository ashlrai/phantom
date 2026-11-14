/** `ashlr fleet board-notify` — the board → source-thread notifier for the
 * Nov12 22:29/22:30 ET orders. One pass: snapshot the work board, diff it
 * against the previous snapshot, plan the ASSIGNED / BLOCKED / VERIFIED
 * notices that carry their required evidence, and reply in the thread the
 * request came from through the existing senders. RUNNING and RECEIVED
 * never post; the sent ledger keeps every delivered `(itemId, state)`
 * entry once-only and every distinct meaningful delta once-only, and
 * the first pass only baselines the snapshot so history
 * is never replayed into threads. `--dry-run` prints the plan and writes
 * or sends nothing; the ~/.ashlr/KILL switch halts sends the same way it
 * halts every other outward channel. Labels grant no authority. */
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { loadAgentNetworkConfig, slackThreadRef, slackTopicForChannel, parseSlackThreadRef,
  isSlackChannelId, isSlackTeamId, isSlackTs } from '../core/agents/slack-network.js';
import { listWorkBoard } from '../core/comms/work-board.js';
import { collectBusWorkItemEvidence } from '../core/comms/work-item-bus-evidence.js';
import { validateBusEnvelope } from '../core/fleet/bus-envelope.js';
import { appendBusInbox } from '../core/fleet/bus-inbox.js';
import { postBusReply } from '../core/fleet/bus-reply-post.js';
import { CHANNEL_BUS_TTL_MS } from '../core/fleet/channel-bus-publish.js';
import { boardNotifyDir, boardNotifyLedgerPath, diffBoard, planNotifications,
  readBoardNotifySent, readBoardNotifySnapshot, sendNotifications, snapshotAfterSend,
  snapshotBoard, writeBoardNotifySnapshot,
  type BoardNotice, type BoardNotifySender, type BoardNotifySenders } from '../core/fleet/work-board-notify.js';
import { killSwitchOn } from '../core/sandbox/policy.js';

const usage = 'Usage: ashlr fleet board-notify [--root <absolute>] [--state-dir <absolute>] [--limit <1..100>] [--dry-run] [--json]\n'
  + 'Diffs the work board against the last snapshot and replies in each item\'s source thread: ASSIGNED <id> — owner,\n'
  + 'BLOCKED <id> — dependency, VERIFIED <id> — PR/head/test artifact. RUNNING and RECEIVED are never posted.\n'
  + 'First live pass only records the baseline snapshot; --dry-run prints the plan without sending or writing.';

/** Deterministic reply identity: a repeated pass for the same
 * (itemId, state, delta) posts the same envelope id, so bus dedupe —
 * not luck — is what makes a retry once-only, while a new meaningful
 * delta earns a new id. */
function noticeReplyId(notice: BoardNotice): string {
  const digest = createHash('sha256').update(`${notice.itemId}|${notice.state}|${notice.delta}`).digest('hex').slice(0, 24);
  return `board-notify-${digest}`;
}

/** Bus-source items get an in-thread bus reply through the existing
 * `postBusReply` sender; the durable post (or its dedupe) is the receipt. */
function busReplySender(root: string): BoardNotifySender {
  return notice => {
    const replyId = noticeReplyId(notice);
    const result = postBusReply(notice.itemId, replyId,
      { kind: 'work-board-notify', state: notice.state, text: notice.text }, { root });
    return result.outcome === 'posted' || result.outcome === 'duplicate'
      ? { status: result.outcome === 'posted' ? 'sent' : 'duplicate', receipt: `bus-reply:${replyId}` }
      : { status: 'refused', reason: result.outcome };
  };
}

interface SlackThread { teamId: string; channelId: string; threadTs: string }

/** Both thread-ref grammars on master: `slack:<team>:<channel>:<rootTs>`
 * (slack-network) and `<team>/<channel>/<threadTs>` (slack-bus-ingress). */
function parseBoardThreadRef(ref: string | null): SlackThread | null {
  if (ref === null) return null;
  const parsed = parseSlackThreadRef(ref);
  if (parsed) return { teamId: parsed.teamId, channelId: parsed.channelId, threadTs: parsed.rootTs };
  const parts = ref.split('/');
  if (parts.length === 3 && isSlackTeamId(parts[0]) && isSlackChannelId(parts[1]) && isSlackTs(parts[2])) {
    return { teamId: parts[0]!, channelId: parts[1]!, threadTs: parts[2]! };
  }
  return null;
}

/** Slack-source items reply into the source thread through the existing
 * reviewed outbound path: a `kind: 'note'` envelope addressed to the
 * topic mapped to the source channel, carrying the `slack:` thread ref,
 * is posted to that Slack thread by the slack bridge's deliver drain
 * (`deliverSlackEnvelope` inside `phm channels slack run`). The durable
 * bus append is the send receipt; without a configured `[slack]` map the
 * sender is absent and the notice stays pending. */
function slackNoteSender(root: string, readConfig: () => ReturnType<typeof loadAgentNetworkConfig>): BoardNotifySender | undefined {
  const parsed = readConfig();
  if (parsed.state !== 'ok' || parsed.slack === undefined || parsed.slack === 'invalid') return undefined;
  const config = parsed.slack;
  return notice => {
    const ref = parseBoardThreadRef(notice.sourceThread);
    if (!ref || ref.teamId !== config.teamId) return { status: 'refused', reason: 'thread-ref-unusable' };
    const topic = slackTopicForChannel(config, ref.channelId);
    if (topic === undefined) return { status: 'refused', reason: 'unmapped-channel' };
    const checked = validateBusEnvelope({
      id: `slack-${noticeReplyId(notice)}`, from: 'work-board-notify', to: topic, priority: 'P2',
      ttl: CHANNEL_BUS_TTL_MS, channel: 'slack', channel_ref: notice.sourceThread!,
      sender: { agent_id: 'work-board-notify', vendor: 'phantom', human: false, team: true },
      external: false, origin_bridge: 'work-board-notify',
      body: { kind: 'note', text: notice.text, thread: slackThreadRef(ref.teamId, ref.channelId, ref.threadTs), inReplyTo: notice.itemId },
    });
    if (!checked.ok) return { status: 'refused', reason: 'invalid-envelope' };
    const post = appendBusInbox(checked.value, { root });
    return post.status === 'posted' || post.status === 'duplicate'
      ? { status: post.status === 'posted' ? 'sent' : 'duplicate', receipt: `bus-note:${post.id}` }
      : { status: 'refused', reason: `bus-${post.status}` };
  };
}

/** What a durable sender receipt proves. Never `slack-delivered`: this command
 * has no Slack transport receipt to read. */
interface NoticeDelivery {
  evidence: 'bus-reply-posted' | 'slack-bus-note-enqueued' | 'sender-receipt';
  transport: 'bus-durable' | 'unconfirmed';
  duplicate: boolean;
}

function deliveryFor(channel: string, injected: boolean, duplicate: boolean): NoticeDelivery {
  if (injected) return { evidence: 'sender-receipt', transport: 'unconfirmed', duplicate };
  return channel === 'slack'
    ? { evidence: 'slack-bus-note-enqueued', transport: 'unconfirmed', duplicate }
    : { evidence: 'bus-reply-posted', transport: 'bus-durable', duplicate };
}

function describeResult(status: string, d: NoticeDelivery | undefined): string {
  if (!d) return status;
  const dup = d.duplicate ? ' (already recorded)' : '';
  if (d.evidence === 'bus-reply-posted') return `posted to bus${dup}`;
  if (d.evidence === 'slack-bus-note-enqueued') return `queued for slack drain, transport delivery unconfirmed${dup}`;
  return `receipt recorded, transport delivery unconfirmed${dup}`;
}

export interface BoardNotifyDeps {
  /** Channel senders; the default wires the real bus reply and the slack
   * drain note when `~/.ashlr/agent-network.toml` maps the channel. */
  senders?: BoardNotifySenders;
  readConfig?: () => ReturnType<typeof loadAgentNetworkConfig>;
  now?: () => number;
  killed?: boolean;
}

export async function cmdFleetBoardNotify(args: string[], deps: BoardNotifyDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let root: string | undefined, stateDir: string | undefined, limit: number | undefined;
  let dryRun = false, json = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--dry-run' && !dryRun) { dryRun = true; continue; }
    if (key === '--json' && !json) { json = true; continue; }
    if (key !== '--root' && key !== '--state-dir' && key !== '--limit') { console.error(usage); return 2; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { console.error(usage); return 2; }
    if (key === '--root' && root === undefined) root = value;
    else if (key === '--state-dir' && stateDir === undefined) stateDir = value;
    else if (key === '--limit' && limit === undefined && /^\d+(?![\s\S])/.test(value)
      && Number(value) >= 1 && Number(value) <= 100) limit = Number(value);
    else { console.error(usage); return 2; }
  }
  if ((root !== undefined && (!isAbsolute(root) || root.includes('\0')))
    || (stateDir !== undefined && (!isAbsolute(stateDir) || stateDir.includes('\0')))) {
    console.error(usage);
    return 2;
  }
  const busRoot = root ?? join(ashlrHome(), 'fleet');
  const dir = stateDir ?? boardNotifyDir();
  const now = (deps.now ?? Date.now)();
  const ledgerPath = boardNotifyLedgerPath(dir);
  const emit = (report: Record<string, unknown>, code = 0): number => {
    if (json) console.log(JSON.stringify(report));
    else for (const line of (report.lines as string[] | undefined) ?? []) console.log(line);
    return code;
  };

  const board = listWorkBoard({ root: busRoot, now, limit });
  if (board.inbox === 'unavailable') return emit({
    status: 'inbox-unavailable', inbox: board.inbox,
    lines: ['board-notify: inbox unavailable; snapshot and sent ledger preserved'],
  }, 1);
  const next = snapshotBoard(board, id => collectBusWorkItemEvidence(id, { root: busRoot, now }).evidence);
  const prev = readBoardNotifySnapshot(dir);
  const sent = readBoardNotifySent(ledgerPath);
  if (sent === null) return emit({ status: 'ledger-unavailable', lines: ['board-notify: sent ledger unreadable; refusing to risk a second post'] }, 1);
  const killed = deps.killed ?? killSwitchOn();
  const transitions = diffBoard(prev ?? [], next);
  const plan = planNotifications(transitions, sent, line => { if (!json) console.error(line); });

  if (dryRun) {
    return emit({
      status: 'dry-run', baselined: prev === null, killed, inbox: board.inbox,
      transitions: transitions.length, planned: plan.notices.length, dropped: plan.dropped,
      lines: [
        `board-notify dry-run: transitions=${transitions.length} planned=${plan.notices.length} dropped=${plan.dropped.length}${prev === null ? ' (first pass would baseline)' : ''}${killed ? ' (KILL armed)' : ''}`,
        ...plan.notices.map(n => `would-post [${n.sourceChannel}${n.sourceThread ? ` ${n.sourceThread}` : ''}] ${n.text}`),
        ...plan.dropped.map(d => `dropped ${d.itemId}: ${d.reason}`),
      ],
    });
  }
  if (killed) return emit({ status: 'halted', planned: plan.notices.length, lines: ['board-notify: KILL is armed; sends halted, snapshot kept for the next pass'] });
  if (prev === null) {
    writeBoardNotifySnapshot(dir, next);
    return emit({ status: 'baselined', items: next.length, planned: plan.notices.length,
      lines: [`board-notify: baseline recorded for ${next.length} item(s); transitions post from the next pass`] });
  }

  const injected = deps.senders !== undefined;
  const senders: BoardNotifySenders = deps.senders ?? {
    bus: busReplySender(busRoot),
    slack: slackNoteSender(busRoot, deps.readConfig ?? loadAgentNetworkConfig),
  };
  // Evidence is derived from which sender produced the durable receipt, never
  // from the receipt text: the default Slack sender only appends a bus note
  // for the separate Slack drain, so transport delivery stays unconfirmed.
  const evidence = new Map<BoardNotice, NoticeDelivery>();
  const tracked: Record<string, BoardNotifySender> = {};
  for (const [channel, sender] of Object.entries(senders)) {
    if (!sender) continue;
    tracked[channel] = async notice => {
      const receipt = await sender(notice);
      if (receipt.status === 'sent' || receipt.status === 'duplicate') {
        evidence.set(notice, deliveryFor(channel, injected, receipt.status === 'duplicate'));
      }
      return receipt;
    };
  }
  const results = await sendNotifications(plan.notices, { senders: tracked, ledgerPath });
  const delivered = results.filter(r => r.status === 'sent' || r.status === 'duplicate');
  const deliveries = results.map(r => ({ itemId: r.notice.itemId, state: r.notice.state, status: r.status,
    ...(evidence.get(r.notice) ?? { evidence: 'none', transport: 'none' }) }));
  const count = (e: NoticeDelivery['evidence']): number => deliveries.filter(d => d.evidence === e).length;
  const queued = count('slack-bus-note-enqueued');
  const busPosted = count('bus-reply-posted');
  const pending = new Set(results.filter(r => r.status !== 'sent' && r.status !== 'duplicate').map(r => r.notice.itemId));
  writeBoardNotifySnapshot(dir, snapshotAfterSend(prev, next, pending));
  return emit({
    status: 'completed', transitions: transitions.length, planned: plan.notices.length,
    // `sent` is the legacy count of durable sender receipts (incl. dedupes). It
    // is NOT a count of Slack deliveries: see `queued`, `busPosted`, `deliveries`.
    sent: delivered.length, queued, busPosted, pending: pending.size, dropped: plan.dropped,
    deliveries,
    lines: [
      `board-notify: transitions=${transitions.length} planned=${plan.notices.length} receipts=${delivered.length} queued=${queued} bus-posted=${busPosted} pending=${pending.size} dropped=${plan.dropped.length}`,
      ...results.map(r => `${describeResult(r.status, evidence.get(r.notice))} [${r.notice.sourceChannel}${r.notice.sourceThread ? ` ${r.notice.sourceThread}` : ''}] ${r.notice.text}${r.reason ? ` (${r.reason})` : ''}`),
      ...plan.dropped.map(d => `dropped ${d.itemId}: ${d.reason}`),
    ],
  });
}
