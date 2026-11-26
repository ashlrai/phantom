/**
 * `phm approvals` — the same projection the desktop Approvals panel renders:
 * decisions only the owner can make (asks, answered with one tap or word), pending
 * team approvals, inbox proposals, outbound drafts, the Security pin queue and
 * Mason's explicit holds. `ask` lets an agent raise a decision; `answer`
 * records Mason's answer, from the local human only.
 * Team approvals and drafts keep their own `phm team` / `phm drafts` verbs.
 */
import { DEFAULT_TEAM, localHumanActor } from '../core/teams/index.js';
import { buildApprovalsProjection, type ApprovalsProjection } from '../core/approvals/surface.js';
import {
  answerApproval, approvalAnswerText, approvalsText, decisionsText, parseDecisionReply, raiseApproval, readDecisions,
  type ApprovalAnswerResult, type ApprovalsOptions, type RaiseApprovalResult,
} from '../core/fleet/approvals.js';
import { OPERATOR_SENDER_ID } from '../core/fleet/channel-envelope.js';
import { rejectUnknownOptions } from './args.js';

const USAGE = `Usage: phm approvals [--team <id>] [--json]
       phm approvals ask --question <text> --options yes,no [--expires <iso>] [--by <name>] [--json]
       phm approvals answer <ref> <option> [--json]
  Decisions only the owner can make come first: number, question, options, who
  asked, age and expiry. Everything else follows: pending team approvals, inbox
  proposals, outbound email drafts, the Security pin queue (read-only) and
  explicit holds from $ASHLR_HOME/holds.json
  ({"holds":[{"id","title","detail?","since?","resolvedAt?"}]}).
  ask      for agents: raise one decision (2-6 options; an identical open one is reused).
           Read the answer with: phm fleet needs-answer <id> [--timeout-ms N]
  answer   for the owner only (agent processes are refused): records the option once,
           with who answered, the channel (cli) and the time; a repeat changes nothing.
           From Telegram, reply "yes 3", or just "use it" when only one approval fits.
  Decide a team approval with: phm team approve|deny <approvalId>
  Decide an email draft with:   phm drafts approve|reject <draftId>`;

const age = (ms: number): string => (ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`);

export function renderApprovals(p: ApprovalsProjection): string {
  const lines: string[] = [...approvalsText(p.asks), ''];
  const head = (title: string, s: { state: string; reason?: string; items: unknown[] }, empty: string) => {
    lines.push(`${title} (${s.items.length})`);
    if (s.state !== 'ok') lines.push(`  unavailable: ${s.reason ?? 'unknown'}`);
    else if (!s.items.length) lines.push(`  ${empty}`);
  };
  head('Team approvals', p.teamApprovals, 'nothing pending');
  for (const a of p.teamApprovals.items) lines.push(`  ! ${a.summary} — from ${a.requestedBy}${a.note ? ` — "${a.note}"` : ''}\n    ${a.command}`);
  head('Inbox proposals', p.proposals, 'nothing pending');
  for (const r of p.proposals.items) {
    lines.push(`  ! ${r.title} — ${r.kind}${r.partial ? ' (partial capture)' : ''}\n    review: ${r.reviewPath}`);
  }
  if (p.proposals.truncated) lines.push('  … truncated');
  head('Outbound drafts', p.drafts, 'nothing pending');
  for (const d of p.drafts.items) {
    lines.push(`  ${d.subject} — to ${d.to} · digest ${d.digestPrefix}\n    ${d.approveCommand} · ${d.rejectCommand}`);
  }
  if (p.drafts.truncated) lines.push('  … truncated');
  head('Security pin queue', p.pins, 'nothing staged');
  for (const s of p.pins.items) lines.push(`  ${s.name} — ${s.filesTouched}${s.truncated ? '+' : ''} files, staged ${age(s.ageMs)} ago`);
  head('Holds', p.holds, p.holds.configured ? 'no open holds' : `no holds configured (${p.holds.path})`);
  for (const h of p.holds.items) lines.push(`  ${h.id}: ${h.title}${h.detail ? ` — ${h.detail}` : ''}${h.since ? ` (since ${h.since})` : ''}`);
  return lines.join('\n');
}

export interface ApprovalsCliDeps {
  options?: ApprovalsOptions;
  /** The local-human check; throws for an agent process or another OS user. */
  localHuman?: typeof localHumanActor;
  raise?: typeof raiseApproval;
  answer?: typeof answerApproval;
  decisions?: typeof readDecisions;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function cmdAsk(args: string[], json: boolean, deps: ApprovalsCliDeps): number {
  const unknown = rejectUnknownOptions(args, { values: ['--question', '--options', '--expires', '--by'] });
  const question = flag(args, '--question');
  const options = flag(args, '--options');
  if (unknown || !question || !options) { console.error(USAGE); return 2; }
  const raised: RaiseApprovalResult = (deps.raise ?? raiseApproval)(
    { question, options, expires: flag(args, '--expires'), askedBy: flag(args, '--by') }, deps.options);
  console.log(json ? JSON.stringify({ schema: 'approvals.ask.v1', ...raised })
    : raised.ok ? `${raised.duplicate ? 'Already asked' : 'Asked'}: approval ${raised.ref} (${raised.id})` : `Not asked: ${raised.reason}`);
  return raised.ok ? 0 : 1;
}

async function cmdAnswer(rest: string[], json: boolean, deps: ApprovalsCliDeps): Promise<number> {
  if (rest.length < 3) { console.error(USAGE); return 2; }
  // The CLI's identity check is the same one `phm team approve` uses: the local human, never an agent process.
  let senderId: string | null = null;
  try { (deps.localHuman ?? localHumanActor)(); senderId = OPERATOR_SENDER_ID; } catch { senderId = null; }
  const outcome: ApprovalAnswerResult = await (deps.answer ?? answerApproval)(rest[1], rest.slice(2).join(' '), { channel: 'cli', senderId }, deps.options);
  console.log(json ? JSON.stringify(outcome) : approvalAnswerText(outcome));
  return outcome.status === 'answered' || outcome.status === 'already-answered' ? 0 : outcome.status === 'invalid' ? 2 : 1;
}

const DECISIONS_USAGE = `Usage: phm decisions [--json]
       phm decisions answer <code> yes|no|later [--json]
  What only the owner can do: a password, a 2FA code, a device approval, a payment,
  or a message to someone outside the team. Each takes one word.
  decisions   waiting questions, oldest first (--json: decisions.v1 with schema and version)
  answer      for the owner only (agent processes are refused): records yes, no or later
              once (y and n work too); a repeat changes nothing. Nothing is paid or sent.
  From a phone, reply "yes 3f2a", or just "yes" when only one decision is waiting.`;

/** \`phm decisions\`: the asks only the owner can answer, one word each; the same ledger and answer path as \`phm approvals\`. */
export async function cmdDecisions(argv: string[], deps: ApprovalsCliDeps = {}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(DECISIONS_USAGE); return 0; }
  const json = argv.includes('--json');
  const rest = argv.filter((arg) => arg !== '--json');
  if (rest.length === 0) {
    const report = (deps.decisions ?? readDecisions)(deps.options);
    console.log(json ? JSON.stringify(report, null, 2) : decisionsText(report).join('\n'));
    return report.ledger === 'unavailable' ? 1 : 0;
  }
  const reply = rest[0] === 'answer' && rest.length === 3 ? parseDecisionReply(rest[2]!) : null;
  if (!reply || reply.code !== null) { console.error(DECISIONS_USAGE); return 2; }
  return cmdAnswer(['answer', rest[1]!, reply.answer], json, deps);
}

export async function cmdApprovals(argv: string[], deps: ApprovalsCliDeps = {}): Promise<number> {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const json = args.includes('--json');
  const rest = args.filter((arg) => arg !== '--json');
  if (rest[0] === 'ask') return cmdAsk(rest.slice(1), json, deps);
  if (rest[0] === 'answer') return cmdAnswer(rest, json, deps);
  const ti = rest.indexOf('--team');
  const team = ti >= 0 ? rest[ti + 1] : undefined;
  if ((ti >= 0 && !team) || rest.length !== (ti >= 0 ? 2 : 0)) { console.error(USAGE); return 2; }
  try {
    const p = await buildApprovalsProjection(team ?? DEFAULT_TEAM, deps.options?.now?.(), deps.options?.runsDir);
    console.log(json ? JSON.stringify(p, null, 2) : renderApprovals(p));
    return 0;
  } catch (err) {
    console.error(`phm approvals: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
