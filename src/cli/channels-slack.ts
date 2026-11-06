/**
 * `phm channels slack` -- offline inspection of the Slack bridge adapter
 * (RQ-AGENTNET-SLACK-1).
 *
 *   slack status [--json]                       agent-network.toml parse state,
 *                                               bridge ids, mappings, phm_
 *                                               reference names (never values),
 *                                               journal counts, next step
 *   slack map [--topic <t>] [--snapshot <file>] [--json]
 *                                               dry-run: topic<->channel table,
 *                                               one topic's route, and -- with a
 *                                               saved conversations.info/members
 *                                               snapshot -- the audience gates
 *                                               and send-policy verdict
 *
 * status/map are read-only. probe/run authenticate a host-injected bot and
 * run the bounded existing-bus transport without accepting token arguments.
 * Exit codes: 0 report printed, 1 input error, 2 bad usage.
 */
import { buildSlackBridgeStatus, buildSlackMapReport, type SlackBridgeStatus } from '../core/agents/slack-status.js';
import type { SlackAudienceSnapshot } from '../core/agents/slack-audience.js';
import { readPrivateFileCapped } from '../core/verse/preferences.js';
import { rejectUnknownOptions } from './args.js';
import { createSlackApi, deliverSlackEnvelope, openSlackSocket, verifySlackIdentity, type SlackSocketSession } from '../core/agents/slack-transport.js';
import { loadAgentNetworkConfig, loadCommsConfirmation } from '../core/agents/slack-network.js';
import { listBusInboxAfter } from '../core/fleet/bus-inbox.js';
import { flushSlackLeaderReplies, ingestSlackLeaderEnvelope, readSlackDeliveryPolicy } from '../core/agents/slack-leader.js';

const SLACK_USAGE = `usage: phm channels slack status [--json]
       phm channels slack map [--topic <topic>] [--snapshot <file>] [--json]
       phm channels slack probe [--json]
       phm channels slack run --seconds <1-300> [--json]`;

const SNAPSHOT_MAX_BYTES = 1024 * 1024;

function badUsage(message?: string): number {
  if (message) console.error(message);
  console.error(SLACK_USAGE);
  return 2;
}

function cell(value: string | number | boolean | null): string {
  if (value === null) return '-';
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return String(value);
}

function printStatus(status: SlackBridgeStatus): void {
  console.log(`config: ${status.config.state} (${status.config.path})`);
  console.log(`slack section: ${status.slackSection}`);
  if (status.bridge !== null) {
    console.log(`bridge: ${status.bridge.id}  team: ${status.bridge.teamId}`);
    console.log(`self ids: user=${cell(status.bridge.ownUserId)} bot=${cell(status.bridge.ownBotId)}`);
  }
  console.log(`credentials: phantom-secrets refs bot=${cell(status.credentials.botTokenRef)} app=${cell(status.credentials.appTokenRef)}`);
  console.log(`mappings: ${status.mappings.length === 0 ? '(none)' : ''}`);
  for (const entry of status.mappings) console.log(`  ${entry.topic} -> ${entry.channel}`);
  console.log(`team identities: slack=${status.teamIdentities.slack} total=${status.teamIdentities.total}`);
  console.log(`comms confirmedByMason: ${cell(status.comms.confirmedByMason)}`);
  console.log(`journal: ${status.journal.state} ingested=${status.journal.ingested} ignored=${status.journal.ignored} last=${cell(status.journal.lastAt)}`);
  console.log(`ready: ${cell(status.ready)}`);
  if (status.next) console.log(`next: ${status.next}`);
}

async function cmdSlackStatus(args: string[]): Promise<number> {
  const bad = rejectUnknownOptions(args, { flags: ['--json'] });
  if (bad) return badUsage(bad.message);
  const status = buildSlackBridgeStatus();
  if (args.includes('--json')) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  printStatus(status);
  return 0;
}

function readSnapshot(path: string): SlackAudienceSnapshot | null {
  const read = readPrivateFileCapped(path, SNAPSHOT_MAX_BYTES);
  if (read === null || read.truncated) return null;
  try {
    const parsed: unknown = JSON.parse(read.text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const conversation = (parsed as Record<string, unknown>)['conversation'];
    const members = (parsed as Record<string, unknown>)['members'];
    if (typeof conversation !== 'object' || conversation === null || Array.isArray(conversation)) return null;
    if (!Array.isArray(members) || members.some((member) => typeof member !== 'object' || member === null || Array.isArray(member))) return null;
    return { conversation: conversation as SlackAudienceSnapshot['conversation'], members: members as SlackAudienceSnapshot['members'] };
  } catch {
    return null;
  }
}

async function cmdSlackMap(args: string[]): Promise<number> {
  const bad = rejectUnknownOptions(args, { flags: ['--json'], values: ['--topic', '--snapshot'] });
  if (bad) return badUsage(bad.message);
  let topic: string | undefined;
  let snapshotPath: string | undefined;
  let json = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--topic') topic = args[++i];
    else if (arg === '--snapshot') snapshotPath = args[++i];
    else if (!arg.startsWith('-')) positional.push(arg);
    else return badUsage(`unexpected argument: ${arg}`);
  }
  if (positional.length > 0) return badUsage(`unexpected argument: ${positional[0]}`);
  if (topic !== undefined && topic.trim() === '') return badUsage('--topic needs a bus topic label');

  let snapshot: SlackAudienceSnapshot | undefined;
  if (snapshotPath !== undefined) {
    const parsed = readSnapshot(snapshotPath);
    if (parsed === null) {
      const error = { ok: false, error: `snapshot is not readable or not a {conversation, members} JSON object: ${snapshotPath}` };
      if (json) console.log(JSON.stringify(error, null, 2));
      else console.error(error.error);
      return 1;
    }
    snapshot = parsed;
  }

  const report = buildSlackMapReport({
    ...(topic !== undefined ? { topic } : {}),
    ...(snapshot !== undefined ? { snapshot } : {}),
  });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`config: ${report.config.state} (${report.config.path})`);
  if (report.bridge !== null) console.log(`bridge: ${report.bridge.id}  team: ${report.bridge.teamId}`);
  console.log('mappings:');
  for (const entry of report.mappings) console.log(`  ${entry.topic} <-> ${entry.channel}   thread: ${entry.threadRefExample}`);
  if (report.mappings.length === 0) console.log('  (none)');
  if (report.route !== undefined) {
    console.log(report.route.ok
      ? `route: ${report.route.topic} -> ${report.route.channel}`
      : `route: ${report.route.topic} -> refused (${report.route.reason ?? 'unmapped-topic'})`);
  }
  if (report.audience !== undefined) {
    const audience = report.audience;
    console.log(`audience: ${audience.status}${audience.reason ? ` (${audience.reason})` : ''} members=${audience.memberCount}`);
    if (audience.refusedMembers !== undefined) console.log(`  refused members: ${audience.refusedMembers.join(', ')}`);
  }
  if (report.sendPolicy !== undefined) console.log(`send policy: ${report.sendPolicy.status} (${report.sendPolicy.reason})`);
  console.log(`comms confirmedByMason: ${cell(report.comms.confirmedByMason)}`);
  console.log(report.note);
  return 0;
}

/** Credentials are supplied to this host process, never accepted in CLI arguments. */
async function cmdSlackTransport(args: string[], run: boolean): Promise<number> {
  const bad = rejectUnknownOptions(args, { flags: ['--json'], values: run ? ['--seconds'] : [] });
  if (bad) return badUsage(bad.message);
  const at = args.indexOf('--seconds');
  const seconds = run ? Number(at >= 0 ? args[at + 1] : 60) : 0;
  if (run && (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300)) return badUsage('--seconds must be 1 through 300');
  const parsed = loadAgentNetworkConfig();
  if (parsed.state !== 'ok' || !parsed.slack || parsed.slack === 'invalid') {
    console.log(JSON.stringify({ ok: false, reason: 'slack-not-configured', observedAt: new Date().toISOString() }));
    return 1;
  }
  const config = parsed.slack;
  const controller = new AbortController();
  const deadline = run ? Date.now() + seconds * 1000 : Infinity;
  const call = createSlackApi({ config, resolveCredential: reference => {
    if (!/^phm_SLACK_(?:AGENTNET_)?(?:BOT|APP)_TOKEN$/.test(reference)) return undefined;
    return process.env[reference.slice(4)];
  }, signal: controller.signal });
  let socket: SlackSocketSession | undefined;
  let stopped = false;
  let disconnected = false;
  const stop = (): void => { stopped = true; controller.abort(); socket?.close(); };
  const deadlineTimer = run ? setTimeout(stop, seconds * 1000) : undefined;
  const sleep = (): Promise<void> => new Promise(resolve => {
    if (controller.signal.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, 1000); controller.signal.addEventListener('abort', done, { once: true });
  });
  const counts = { sent: 0, duplicate: 0, uncertain: 0, refused: 0 };
  try {
    await verifySlackIdentity(call, config);
    if (run) {
      socket = await openSlackSocket({ call, config, ingest: { config, teamIdentities: parsed.teamIdentities },
        signal: controller.signal,
        owner: envelope => ingestSlackLeaderEnvelope(envelope, { call, signal: controller.signal }),
        readIngest: () => {
          const current = readSlackDeliveryPolicy();
          return current && JSON.stringify(current.config) === JSON.stringify(config) ? { config, teamIdentities: current.teamIdentities } : undefined;
        },
        connect: url => new WebSocket(url) as unknown as SlackSocketSession });
      socket.addEventListener('close', () => { if (!stopped) { disconnected = true; stop(); } });
      socket.addEventListener('error', () => { if (!stopped) { disconnected = true; stop(); } });
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
      let cursor = 0;
      while (!stopped && Date.now() < deadline) {
        const owners = await flushSlackLeaderReplies({ call, signal: controller.signal });
        if (owners.state !== 'completed') throw new Error('leader-slack-unavailable');
        counts.sent += owners.sent;
        // The existing bus owns body persistence and TTL. Do not mirror private
        // iMessage/email input: the planner accepts only authored local results.
        const page = listBusInboxAfter(cursor, 100);
        if (page.status !== 'ok') throw new Error('bus-unavailable');
        for (const row of page.messages) {
          if (stopped || Date.now() >= deadline) break;
          cursor = row.cursor;
          if (!config.map.some(mapping => mapping.topic === row.envelope.to) || row.envelope.origin_bridge === config.bridgeId ||
              row.envelope.channel === 'imessage' || row.envelope.channel === 'email') continue;
          const ttl = row.envelope.ttl - Math.max(0, Date.now() - row.receivedAt);
          if (ttl <= 0) continue;
          const result = await deliverSlackEnvelope(row.envelope, { config, teamIdentities: parsed.teamIdentities,
            confirmedByMason: loadCommsConfirmation(), call, signal: controller.signal, readPolicy: () => readSlackDeliveryPolicy() });
          counts[result.status]++;
          // The channel API permits roughly one post/second. Never spin on an
          // uncertain outcome; a future pass performs read-only reconciliation.
          await sleep();
        }
        await sleep();
      }
      if (disconnected) throw new Error('slack-socket-disconnected');
    }
    console.log(JSON.stringify({ ok: true, teamId: config.teamId, userId: config.ownUserId, botId: config.ownBotId,
      mode: run ? 'socket-session' : 'authenticated-probe', ...counts, observedAt: new Date().toISOString() }));
    return 0;
  } catch {
    if (run && controller.signal.aborted && !disconnected && (stopped || Date.now() >= deadline)) {
      console.log(JSON.stringify({ ok: true, mode: 'socket-session', stopped: 'bounded-stop', ...counts, observedAt: new Date().toISOString() }));
      return 0;
    }
    console.log(JSON.stringify({ ok: false, reason: 'transport-unavailable-or-identity-mismatch', ...counts, observedAt: new Date().toISOString() }));
    return 1;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    stop(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}

export async function cmdChannelsSlack(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === '--help' || sub === '-h' || sub === 'help' || sub === undefined) {
    console.log(SLACK_USAGE);
    console.log('');
    console.log('  status/map inspect offline. probe/run require host-injected credentials,');
    console.log('  matching workspace/bot identity and explicitly approved team recipients.');
    return 0;
  }
  if (sub === 'status') return cmdSlackStatus(args.slice(1));
  if (sub === 'map') return cmdSlackMap(args.slice(1));
  if (sub === 'probe') return cmdSlackTransport(args.slice(1), false);
  if (sub === 'run') return cmdSlackTransport(args.slice(1), true);
  return badUsage(`unknown slack subcommand: ${sub}`);
}
