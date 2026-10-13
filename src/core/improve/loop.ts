/**
 * Self-improvement proposal loop: turn evidence into proposals and open them as
 * PRs (draft, or ready with auto-merge armed so they merge only on green). It
 * never pushes to the default branch, never uses --admin and never tags/deploys.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { listContext, teamState } from '../teams/index.js';
import { scrubSecrets } from '../util/scrub.js';
import type { StewardReport } from '../steward/disk.js';

export interface Evidence { ref: string; summary: string }
/**
 * `title`/`rationale`/`evidence` are PUBLIC: they are the only fields that can
 * reach a draft PR branch, title or body. Private feedback, team context and
 * handoff text live in `local` and are only shown on the owner's terminal.
 */
export interface Proposal { id: string; title: string; rationale: string; evidence: Evidence[]; evalPlan: string; metric: string; local?: { title: string; rationale: string; evidence: Evidence[] } }

/** Only public GitHub links count as publishable evidence. */
export function isPublicEvidenceRef(ref: string): boolean {
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull|commit|discussions|actions\/runs)\/[\w-]+(#[\w-]+)?$/.test(ref);
}
function publicEvidence(ev: Evidence[]): Evidence[] {
  const pub = ev.filter((e) => isPublicEvidenceRef(e.ref)).map((e) => ({ ref: e.ref, summary: 'public evidence' }));
  const withheld = ev.length - pub.length;
  return withheld ? [...pub, { ref: 'local-only', summary: `${withheld} private evidence item(s) withheld; view locally with \`phm improve\`` }] : pub;
}

const pid = (title: string) => createHash('sha256').update(title).digest('hex').slice(0, 10);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export function gatherProposals(team: string, steward?: StewardReport): Proposal[] {
  const out: Proposal[] = [];
  const st = teamState(team);
  const declined = st.handoffs.filter((h) => h.state === 'declined');
  if (declined.length >= 2) {
    const title = `Reduce declined handoffs (${declined.length})`;
    const ev = declined.slice(0, 10).map((h) => ({ ref: `team:${team}/handoff/${h.id}`, summary: h.title }));
    const rationale = 'Repeated declined handoffs suggest routing to the wrong agent or missing capabilities.';
    out.push({ id: pid(title), title, rationale, evidence: publicEvidence(ev), local: { title, rationale, evidence: ev }, evalPlan: 'Replay the declined handoffs against capability-aware routing in a fixture team.', metric: 'handoff decline rate' });
  }
  for (const r of steward?.roots ?? []) {
    if (!r.overQuota) continue;
    const title = `Native retention for ${r.id}`;
    out.push({ id: pid(title), title, rationale: `${r.id} is over its quota (${Math.round(r.bytes / 1048576)} MB).`, evidence: [{ ref: `steward:${r.id}`, summary: `${r.files} files, reclaimable ${Math.round(r.reclaimable.bytes / 1048576)} MB` }], evalPlan: 'Steward fixture shows the root stays under quota for 30 simulated days.', metric: 'agent log disk usage' });
  }
  const feedback = listContext(team).filter((e) => e.tags.some((t) => t === 'feedback' || t === 'bug' || t === 'feature-request'));
  for (const f of feedback.slice(0, 10)) {
    const localTitle = `Address: ${f.title}`;
    const id = pid(localTitle);
    const ev = [{ ref: f.source, summary: f.title }];
    out.push({ id, title: `Address feedback item ${id}`, rationale: 'A team feedback/bug report (private; details withheld from the PR).', evidence: publicEvidence(ev), local: { title: localTitle, rationale: f.text.slice(0, 600), evidence: ev }, evalPlan: 'Add a failing test or eval reproducing the report, then make it pass.', metric: 'task success rate on the reported workflow' });
  }
  return out;
}

/** Local terminal view; includes private detail. Never pass this to git/gh. */
export function renderProposal(p: Proposal, opts: { includeLocal?: boolean } = {}): string {
  if (opts.includeLocal && p.local) p = { ...p, ...p.local };
  return [`# Proposal ${p.id}: ${p.title}`, '', `_Opened by Phantom's self-improvement loop under CONSTITUTION.md. Draft only; a human approves merges and deploys._`, '', '## Why', p.rationale, '', '## Evidence', ...p.evidence.map((e) => `- ${e.summary} (${e.ref})`), '', '## Eval', p.evalPlan, '', '## Metric to move', p.metric, ''].join('\n');
}

/** What may leave the machine: public fields only, secret-scrubbed. */
export function renderPublicProposal(p: Proposal): string {
  return scrubSecrets(renderProposal({ ...p, local: undefined, evidence: publicEvidence(p.evidence) }));
}

export type Exec = (cmd: string, args: string[], cwd: string) => string;
const realExec: Exec = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Open one proposal as a draft PR from an isolated worktree. Returns the PR URL. */
export interface OpenPrOptions { /** Open ready (not draft) and arm GitHub auto-merge so it merges on green. */ autoMerge?: boolean }

export function openProposalPr(p: Proposal, repoDir: string, exec: Exec = realExec, opts: OpenPrOptions = {}): string {
  const base = exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir).trim().replace(/^origin\//, '') || 'main';
  const branch = `improve/${p.id}-${slug(p.title)}`;
  if (branch === base) throw new Error('Refusing to write to the default branch.');
  const wt = join(tmpdir(), `phm-improve-${p.id}`);
  rmSync(wt, { recursive: true, force: true });
  exec('git', ['fetch', 'origin', base], repoDir);
  exec('git', ['worktree', 'add', '-b', branch, wt, `origin/${base}`], repoDir);
  try {
    mkdirSync(join(wt, 'workplans', 'proposals'), { recursive: true });
    writeFileSync(join(wt, 'workplans', 'proposals', `${p.id}.md`), renderPublicProposal(p));
    exec('git', ['add', 'workplans/proposals'], wt);
    exec('git', ['commit', '-m', `proposal: ${p.title}`], wt);
    exec('git', ['push', '-u', 'origin', branch], wt);
    const url = exec('gh', ['pr', 'create', ...(opts.autoMerge ? [] : ['--draft']), '--base', base, '--head', branch, '--title', `proposal: ${p.title}`, '--body', renderPublicProposal(p)], wt).trim();
    if (opts.autoMerge) {
      // GitHub merges only when required checks/reviews pass; never --admin.
      try { exec('gh', ['pr', 'merge', url, '--auto', '--squash'], wt); } catch { /* auto-merge disabled on repo: PR stays open for a merge-on-green runner */ }
    }
    return url;
  } finally {
    try { exec('git', ['worktree', 'remove', '--force', wt], repoDir); } catch { /* best effort */ }
  }
}
