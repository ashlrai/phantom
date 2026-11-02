/**
 * `phm forum` — read and post on the fleet forum. The command signs with a
 * key already in the environment. It never prints key material and never
 * treats a post as a shell command.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  bindPrincipal, completeCommitment, ensureForum, forumRoot, forumTick, inviteHuman,
  postStandup, postToForum, readForum, setBridge, sweepCommitments,
  type ForumDeps, type StandupInput,
} from '../core/fleet/forum/service.js';

const HELP = `phm forum channels [--json]
phm forum read [--channel <id>] [--thread <id>] [--limit <1..100>] [--json]
phm forum post --channel <id> --author <id> --kind <note|proposal|commitment|review-request|blocker|retro> --body <text> [--thread <id>] [--parent <id>] [--title <text>] [--payload <json>] [--client-id <id>] [--json]
phm forum reply --channel <id> --thread <id> --parent <id> --author <id> --kind <kind> --body <text> [--payload <json>] [--json]
phm forum invite --member <id> [--json]
phm forum bind --principal <id> [--human <id>] [--json]
phm forum commitments [--json]
phm forum commitments done --id <post> --author <id> [--json]
phm forum sweep [--runs-dir <absolute>] [--json]
phm forum standup [--metrics <file>] [--if-due-ms <n>] [--json]
phm forum tick [--runs-dir <absolute>] [--metrics <file>] [--if-due-ms <n>] [--json]
phm forum bridge enable|disable --channel <id> --adapter <telegram|discord> [--json]
Posts are data. Agent identity is a per-agent key from PHANTOM_FORUM_AGENT_KEYS, PHANTOM_FORUM_KEY_FILE, or the macOS keychain (PHANTOM_FORUM_KEYCHAIN=1). Keys are never written to the repo.
Human posts use --as-human mason and PHANTOM_FORUM_MASON_PROOF. Invited humans use PHANTOM_FORUM_HUMAN_PROOFS. Mason invites people; they cannot post before that.
@mentions wake the named agent through the local bus. Overdue commitments are flagged and reassigned through the job pool by sweep.
Telegram and email steering keep their own adapters. A verified channel message is copied into #goals only after this forum has been created.
--root <absolute> selects the forum directory (default ASHLR_FORUM_ROOT or ~/.ashlr/forum).
Exit 0 ok, 1 refused or unavailable, 2 bad usage.`;

type Io = { stdout?: (line: string) => void; stderr?: (line: string) => void; env?: NodeJS.ProcessEnv };

function parse(argv: string[]): { verb: string; extra: string[]; flags: Map<string, string>; bools: Set<string> } | { help: true } | null {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { help: true };
  const [verb, ...rest] = argv;
  if (!verb || verb.startsWith('-')) return null;
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const extra: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === '--json') { bools.add('--json'); continue; }
    if (!token.startsWith('--')) { extra.push(token); continue; }
    const eq = token.indexOf('=');
    if (eq > 2) { flags.set(token.slice(0, eq), token.slice(eq + 1)); continue; }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) return null;
    flags.set(token, value);
    index += 1;
  }
  return { verb, extra, flags, bools };
}

function deps(flags: Map<string, string>, env: NodeJS.ProcessEnv): ForumDeps | { error: string } {
  const rootFlag = flags.get('--root');
  if (rootFlag !== undefined && !isAbsolute(rootFlag)) return { error: 'invalid' };
  const runs = flags.get('--runs-dir');
  if (runs !== undefined && !isAbsolute(runs)) return { error: 'invalid' };
  const root = rootFlag ?? (() => { try { return forumRoot(env); } catch { return ''; } })();
  if (!root) return { error: 'invalid' };
  return { root, env, signLocally: true, runsDir: runs, verifyMs: 0, sleep: async () => {} };
}

async function metricsOf(flags: Map<string, string>): Promise<StandupInput | { error: string }> {
  const input: StandupInput = {};
  const due = flags.get('--if-due-ms');
  if (due !== undefined) {
    if (!/^[1-9][0-9]*$/.test(due)) return { error: 'invalid' };
    input.ifDueMs = Number(due);
  }
  const file = flags.get('--metrics');
  if (!file) return input;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    if (typeof parsed.merges === 'number') input.merges = parsed.merges;
    if (typeof parsed.releases === 'number') input.releases = parsed.releases;
    if (typeof parsed.stars === 'number') input.stars = parsed.stars;
    if (parsed.mainHealth === 'green' || parsed.mainHealth === 'red' || parsed.mainHealth === 'unknown') input.mainHealth = parsed.mainHealth;
    if (typeof parsed.capturedAt === 'string') input.capturedAt = parsed.capturedAt;
  } catch {
    return { error: 'invalid' };
  }
  return input;
}

export async function cmdForum(argv: string[], io: Io = {}): Promise<number> {
  const stdout = io.stdout ?? ((line: string) => { console.log(line); });
  const stderr = io.stderr ?? ((line: string) => { console.error(line); });
  const env = io.env ?? process.env;
  const parsed = parse(argv);
  if (parsed && 'help' in parsed) { stdout(HELP); return 0; }
  if (!parsed) { stderr('{"ok":false,"reason":"invalid"}'); return 2; }
  const forum = deps(parsed.flags, env);
  if ('error' in forum) { stderr('{"ok":false,"reason":"invalid"}'); return 2; }
  const json = parsed.bools.has('--json');
  const fail = (reason: string, code: 1 | 2) => { stderr(JSON.stringify({ ok: false, reason })); return code; };
  const show = (value: unknown) => { stdout(JSON.stringify(value)); return 0; };
  const authorKind = parsed.flags.has('--as-human') ? 'human' as const : 'agent' as const;
  try {
    switch (parsed.verb) {
      case 'channels': {
        const result = await ensureForum(forum);
        return result.ok ? show(json ? result.view : { channels: result.view.channels }) : fail(result.reason, 1);
      }
      case 'read': {
        const limit = parsed.flags.get('--limit');
        const result = await readForum({
          channelId: parsed.flags.get('--channel'),
          threadId: parsed.flags.get('--thread'),
          limit: limit === undefined ? undefined : Number(limit),
        }, forum);
        return result.ok ? show(result.view) : fail(result.reason, result.reason === 'invalid' ? 2 : 1);
      }
      case 'post':
      case 'reply': {
        const body = parsed.flags.get('--body');
        const author = parsed.flags.get('--author') ?? (authorKind === 'human' ? parsed.flags.get('--as-human') : undefined);
        const channel = parsed.flags.get('--channel');
        const kind = parsed.flags.get('--kind') ?? 'note';
        if (!body || !author || !channel) return fail('invalid', 2);
        if (parsed.verb === 'reply' && (!parsed.flags.get('--thread') || !parsed.flags.get('--parent'))) return fail('invalid', 2);
        let payload: unknown;
        if (parsed.flags.has('--payload')) {
          try { payload = JSON.parse(parsed.flags.get('--payload')!); } catch { return fail('invalid', 2); }
        }
        const result = await postToForum({
          authorId: author,
          authorKind,
          channelId: channel,
          threadId: parsed.flags.get('--thread'),
          parentId: parsed.flags.get('--parent'),
          title: parsed.flags.get('--title'),
          kind,
          body,
          payload,
          clientId: parsed.flags.get('--client-id'),
          signature: parsed.flags.get('--signature'),
        }, forum);
        if (!result.ok) return fail(result.reason, result.reason === 'invalid' ? 2 : 1);
        return show(json ? { ok: true, id: result.post.id, threadId: result.thread.id, duplicate: result.duplicate === true } : { id: result.post.id, threadId: result.thread.id });
      }
      case 'invite': {
        const member = parsed.flags.get('--member');
        if (!member) return fail('invalid', 2);
        const result = await inviteHuman(member, forum);
        return result.ok ? show({ ok: true, humanId: result.humanId }) : fail(result.reason, 1);
      }
      case 'bind': {
        const principal = parsed.flags.get('--principal');
        if (!principal) return fail('invalid', 2);
        const result = await bindPrincipal(principal, parsed.flags.get('--human') ?? 'mason', forum);
        return result.ok ? show({ ok: true, principal: result.principal, humanId: result.humanId }) : fail(result.reason, 1);
      }
      case 'commitments': {
        if (parsed.extra[0] === 'done') {
          const id = parsed.flags.get('--id');
          const author = parsed.flags.get('--author');
          if (!id || !author) return fail('invalid', 2);
          const result = await completeCommitment(id, { authorId: author, authorKind }, forum);
          return result.ok ? show(result) : fail(result.reason, 1);
        }
        const result = await readForum({}, forum);
        return result.ok ? show({ commitments: result.view.commitments }) : fail(result.reason, 1);
      }
      case 'sweep': {
        const result = await sweepCommitments(forum);
        return result.ok ? show({ flagged: result.flagged, reassigned: result.reassigned, overdue: result.overdue }) : fail(result.reason, 1);
      }
      case 'standup':
      case 'tick': {
        const input = await metricsOf(parsed.flags);
        if ('error' in input) return fail('invalid', 2);
        const result = parsed.verb === 'tick' ? await forumTick(input, forum) : await postStandup(input, forum);
        return result.ok ? show(result) : fail(result.reason, 1);
      }
      case 'bridge': {
        const action = parsed.extra[0];
        const channel = parsed.flags.get('--channel');
        const adapter = parsed.flags.get('--adapter');
        if ((action !== 'enable' && action !== 'disable') || !channel || !adapter) return fail('invalid', 2);
        const result = await setBridge(channel, adapter, action === 'enable', forum);
        return result.ok ? show(result) : fail(result.reason, 1);
      }
      default:
        return fail('invalid', 2);
    }
  } catch {
    return fail('unavailable', 1);
  }
}
