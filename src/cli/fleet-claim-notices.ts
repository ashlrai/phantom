/** `ashlr fleet claim-notices` — one send pass over the claim ledger for
 * the Nov12/13 Slack coordination orders: diff the live board against the
 * stored snapshot, then post each planned ASSIGNED / RELEASED / BLOCKED /
 * VERIFIED notice into the Slack thread the request came from through the
 * existing reviewed outbound path — a `kind: 'note'` bus envelope carrying
 * the `slack:` thread ref, drained by `deliverSlackEnvelope` inside
 * `phm channels slack run`. The durable bus append (or its dedupe) is the
 * send receipt; there is no Slack transport receipt to read here, so
 * delivery to Slack itself stays unconfirmed. `--dry-run` prints the plan
 * and sends or writes nothing; the ~/.ashlr/KILL switch halts sends the
 * same way it halts every other outward channel. Labels grant no
 * authority. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { loadAgentNetworkConfig, slackThreadRef, slackTopicForChannel, parseSlackThreadRef,
  isSlackChannelId, isSlackTeamId, isSlackTs } from '../core/agents/slack-network.js';
import { appendBusInbox } from '../core/fleet/bus-inbox.js';
import { validateBusEnvelope } from '../core/fleet/bus-envelope.js';
import { CHANNEL_BUS_TTL_MS } from '../core/fleet/channel-bus-publish.js';
import { claimNoticeFileDeps, runClaimNoticePass,
  type ClaimNoticeSend, type ClaimNoticeSendDeps, type ClaimNoticePassResult } from '../core/fleet/claim-notice-send.js';
import { readFleetBoard } from '../core/fleet/coordination.js';
import { killSwitchOn } from '../core/sandbox/policy.js';

const usage = 'Usage: ashlr fleet claim-notices [--dry-run] [--json]\n'
  + 'Posts each claim transition (ASSIGNED / RELEASED / BLOCKED / VERIFIED) into the\n'
  + 'Slack thread recorded in claim-thread-bindings.jsonl. The sent ledger fences every\n'
  + 'dedupe key once-only; a failed send leaves the snapshot unchanged so the next pass\n'
  + 'retries. --dry-run prints the plan without sending or writing.';

export interface SlackThread { teamId: string; channelId: string; threadTs: string }

/** Both thread-ref grammars on master: `slack:<team>:<channel>:<rootTs>`
 * (slack-network) and `<team>/<channel>/<threadTs>` (slack-bus-ingress).
 * Exported for the read-only claim-notice delivery view, which must parse a
 * bound threadKey exactly the way the real sender does. */
export function parseNoticeThreadRef(ref: string): SlackThread | null {
  const parsed = parseSlackThreadRef(ref);
  if (parsed) return { teamId: parsed.teamId, channelId: parsed.channelId, threadTs: parsed.rootTs };
  const parts = ref.split('/');
  if (parts.length === 3 && isSlackTeamId(parts[0]) && isSlackChannelId(parts[1]) && isSlackTs(parts[2])) {
    return { teamId: parts[0]!, channelId: parts[1]!, threadTs: parts[2]! };
  }
  return null;
}

/** Deterministic transport identity: a repeated pass for the same dedupeKey
 * posts the same envelope id, so bus dedupe — not luck — is what makes a
 * retry once-only (covers the send-succeeded/ledger-append-failed gap). */
function noticeEnvelopeId(dedupeKey: string): string {
  return `claim-notice-${createHash('sha256').update(dedupeKey).digest('hex').slice(0, 24)}`;
}

/** Slack-source claims reply into the bound thread through the bus drain.
 * Without a configured `[slack]` map the notice stays pending and retries. */
export function claimNoticeSlackSender(
  busRoot: string,
  readConfig: () => ReturnType<typeof loadAgentNetworkConfig>,
): ClaimNoticeSend {
  return (threadKey, text, dedupeKey) => {
    const parsed = readConfig();
    if (parsed.state !== 'ok' || parsed.slack === undefined || parsed.slack === 'invalid') {
      return { ok: false, reason: 'slack-unconfigured' };
    }
    const ref = parseNoticeThreadRef(threadKey);
    if (ref === null || ref.teamId !== parsed.slack.teamId) return { ok: false, reason: 'thread-ref-unusable' };
    const topic = slackTopicForChannel(parsed.slack, ref.channelId);
    if (topic === undefined) return { ok: false, reason: 'unmapped-channel' };
    const checked = validateBusEnvelope({
      id: noticeEnvelopeId(dedupeKey), from: 'claim-notice-send', to: topic, priority: 'P2',
      ttl: CHANNEL_BUS_TTL_MS, channel: 'slack', channel_ref: threadKey,
      sender: { agent_id: 'claim-notice-send', vendor: 'phantom', human: false, team: true },
      external: false, origin_bridge: 'claim-notice-send',
      body: { kind: 'note', text, thread: slackThreadRef(ref.teamId, ref.channelId, ref.threadTs),
        inReplyTo: dedupeKey },
    });
    if (!checked.ok) return { ok: false, reason: 'invalid-envelope' };
    const post = appendBusInbox(checked.value, { root: busRoot });
    // Only 'posted' or an identical 'duplicate' proves this notice was
    // durably enqueued. 'conflict' means a DIFFERENT envelope already holds
    // the deterministic id: the bus cannot prove destination, thread, body
    // or provenance equivalence, so it is an honest failure the pass keeps
    // pending and retries rather than a receipt the ledger may claim.
    if (post.status === 'posted' || post.status === 'duplicate') {
      return { ok: true, receipt: `bus-note:${post.id}` };
    }
    return { ok: false, reason: `bus-${post.status}` };
  };
}

export interface ClaimNoticeCliDeps extends Partial<ClaimNoticeSendDeps> {
  /** Test/operator seam for the KILL check; defaults to `killSwitchOn()`. */
  killed?: boolean;
  readConfig?: () => ReturnType<typeof loadAgentNetworkConfig>;
  /** Bus inbox root; defaults to `~/.ashlr/fleet`. */
  busRoot?: string;
  /** State dir override; defaults to the fleet runs root. */
  runsRoot?: string;
}

/** Real-send pass deps (live board, file-backed ledger, bus-note sender),
 * each overridable; shared by this CLI and the `channels slack run` tick. */
export function claimNoticePassDeps(deps: ClaimNoticeCliDeps = {}, dryRun = false): ClaimNoticeSendDeps {
  const now = deps.now ?? Date.now;
  const files = claimNoticeFileDeps(deps.runsRoot);
  return {
    readBoard: deps.readBoard ?? (() => readFleetBoard({ now: now() })),
    readPrevSnapshot: deps.readPrevSnapshot ?? files.readPrevSnapshot,
    readPrevSnapshotState: deps.readPrevSnapshotState
      ?? (deps.readPrevSnapshot ? undefined : files.readPrevSnapshotState),
    writePrevSnapshot: deps.writePrevSnapshot ?? files.writePrevSnapshot,
    readBindings: deps.readBindings ?? files.readBindings,
    readSentLedger: deps.readSentLedger ?? files.readSentLedger,
    appendSentLedger: deps.appendSentLedger ?? files.appendSentLedger,
    noticeTime: deps.noticeTime ?? files.noticeTime,
    send: deps.send ?? claimNoticeSlackSender(
      deps.busRoot ?? join(ashlrHome(), 'fleet'), deps.readConfig ?? loadAgentNetworkConfig),
    now, dryRun,
  };
}

export async function cmdFleetClaimNotices(args: string[], deps: ClaimNoticeCliDeps = {}): Promise<number> {
  let dryRun = false;
  let json = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--dry-run' && !dryRun) { dryRun = true; continue; }
    if (arg === '--json' && !json) { json = true; continue; }
    console.error(usage);
    return 2;
  }
  const emit = (report: Record<string, unknown>, code: number): number => {
    if (json) console.log(JSON.stringify(report));
    else for (const line of (report.lines as string[] | undefined) ?? []) console.log(line);
    return code;
  };
  const reportOf = (result: ClaimNoticePassResult): Record<string, unknown> => ({
    status: result.status, ...(result.reason ? { reason: result.reason } : {}),
    baselined: result.baselined, planned: result.planned, sent: result.sent,
    failed: result.failed, skipped: result.skipped,
    notices: result.deliveries.map(d => ({
      threadKey: d.threadKey, state: d.state, dedupeKey: d.dedupeKey, result: d.result,
      ...(d.receipt ? { receipt: d.receipt } : {}), ...(d.reason ? { reason: d.reason } : {}), text: d.text,
    })),
    lines: [
      `claim-notices: status=${result.status} planned=${result.planned} sent=${result.sent} `
        + `skipped=${result.skipped} failed=${result.failed}${result.baselined ? ' (baseline only)' : ''}`
        + `${result.reason ? ` reason=${result.reason}` : ''}`,
      ...result.deliveries.map(d =>
        `${result.status === 'dry-run' && d.result === 'planned' ? 'would-post' : d.result} [${d.threadKey}] ${d.text}${d.reason ? ` (${d.reason})` : ''}`),
    ],
  });

  const killed = deps.killed ?? killSwitchOn();
  if (killed && !dryRun) {
    return emit({ status: 'halted',
      lines: ['claim-notices: KILL is armed; sends halted, snapshot kept for the next pass'] }, 0);
  }
  const result = await runClaimNoticePass(claimNoticePassDeps(deps, dryRun));
  const report = reportOf(result);
  if (killed) report['killed'] = true;
  return emit(report,
    result.status === 'completed' || result.status === 'dry-run' ? (result.failed > 0 ? 1 : 0) : 1);
}
