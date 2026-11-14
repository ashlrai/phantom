/**
 * `phm approvals` — the same projection the desktop Approvals panel renders:
 * pending team approvals, inbox proposals, outbound drafts, the Security pin
 * queue and Mason's explicit holds. Read-only; decisions stay in
 * `phm team approve|deny` and `phm drafts approve|reject` (human identity only).
 */
import { DEFAULT_TEAM } from '../core/teams/index.js';
import { buildApprovalsProjection, type ApprovalsProjection } from '../core/approvals/surface.js';

const USAGE = `Usage: phm approvals [--team <id>] [--json]
  Pending team approvals, inbox proposals, outbound email drafts, the Security
  pin queue (read-only) and explicit holds from $ASHLR_HOME/holds.json
  ({"holds":[{"id","title","detail?","since?","resolvedAt?"}]}).
  Decide a team approval with: phm team approve|deny <approvalId>
  Decide an email draft with:   phm drafts approve|reject <draftId>`;

const age = (ms: number): string => (ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`);

export function renderApprovals(p: ApprovalsProjection): string {
  const lines: string[] = [];
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

export async function cmdApprovals(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const json = args.includes('--json');
  const ti = args.indexOf('--team');
  const team = ti >= 0 ? args[ti + 1] : undefined;
  if (ti >= 0 && !team) { console.error(USAGE); return 2; }
  try {
    const p = await buildApprovalsProjection(team ?? DEFAULT_TEAM);
    console.log(json ? JSON.stringify(p, null, 2) : renderApprovals(p));
    return 0;
  } catch (err) {
    console.error(`phm approvals: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
