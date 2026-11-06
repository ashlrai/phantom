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
 * Read-only: no Socket Mode connection, no Slack Web API call, no credential
 * is read or resolved. Posting ships in the separately reviewed -sec change.
 * Exit codes: 0 report printed, 1 input error, 2 bad usage.
 */
import { buildSlackBridgeStatus, buildSlackMapReport, type SlackBridgeStatus } from '../core/agents/slack-status.js';
import type { SlackAudienceSnapshot } from '../core/agents/slack-audience.js';
import { readPrivateFileCapped } from '../core/verse/preferences.js';
import { rejectUnknownOptions } from './args.js';

const SLACK_USAGE = `usage: phm channels slack status [--json]
       phm channels slack map [--topic <topic>] [--snapshot <file>] [--json]`;

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

export async function cmdChannelsSlack(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === '--help' || sub === '-h' || sub === 'help' || sub === undefined) {
    console.log(SLACK_USAGE);
    console.log('');
    console.log('  Offline inspection only. Token values stay in Phantom Secrets custody;');
    console.log('  the socket, token injection and post path ship in the -sec change.');
    return 0;
  }
  if (sub === 'status') return cmdSlackStatus(args.slice(1));
  if (sub === 'map') return cmdSlackMap(args.slice(1));
  return badUsage(`unknown slack subcommand: ${sub}`);
}
