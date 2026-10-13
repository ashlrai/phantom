/**
 * Self-improvement proposal loop (Phase 1): turn evidence into proposals and,
 * when asked, open them as DRAFT pull requests. It never merges, never pushes
 * to the default branch and never deploys (CONSTITUTION.md "Always ask").
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { listContext, teamState } from '../teams/index.js';
import type { StewardReport } from '../steward/disk.js';

export interface Evidence { ref: string; summary: string }
export interface Proposal { id: string; title: string; rationale: string; evidence: Evidence[]; evalPlan: string; metric: string }

const pid = (title: string) => createHash('sha256').update(title).digest('hex').slice(0, 10);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export function gatherProposals(team: string, steward?: StewardReport): Proposal[] {
  const out: Proposal[] = [];
  const st = teamState(team);
  const declined = st.handoffs.filter((h) => h.state === 'declined');
  if (declined.length >= 2) {
    const title = `Reduce declined handoffs (${declined.length})`;
    out.push({ id: pid(title), title, rationale: 'Repeated declined handoffs suggest routing to the wrong agent or missing capabilities.', evidence: declined.slice(0, 10).map((h) => ({ ref: `team:${team}/handoff/${h.id}`, summary: h.title })), evalPlan: 'Replay the declined handoffs against capability-aware routing in a fixture team.', metric: 'handoff decline rate' });
  }
  for (const r of steward?.roots ?? []) {
    if (!r.overQuota) continue;
    const title = `Native retention for ${r.id}`;
    out.push({ id: pid(title), title, rationale: `${r.id} is over its quota (${Math.round(r.bytes / 1048576)} MB).`, evidence: [{ ref: `steward:${r.id}`, summary: `${r.files} files, reclaimable ${Math.round(r.reclaimable.bytes / 1048576)} MB` }], evalPlan: 'Steward fixture shows the root stays under quota for 30 simulated days.', metric: 'agent log disk usage' });
  }
  const feedback = listContext(team).filter((e) => e.tags.some((t) => t === 'feedback' || t === 'bug' || t === 'feature-request'));
  for (const f of feedback.slice(0, 10)) {
    const title = `Address: ${f.title}`;
    out.push({ id: pid(title), title, rationale: f.text.slice(0, 600), evidence: [{ ref: f.source, summary: f.title }], evalPlan: 'Add a failing test or eval reproducing the report, then make it pass.', metric: 'task success rate on the reported workflow' });
  }
  return out;
}

export function renderProposal(p: Proposal): string {
  return [`# Proposal ${p.id}: ${p.title}`, '', `_Opened by Phantom's self-improvement loop under CONSTITUTION.md. Draft only; a human approves merges and deploys._`, '', '## Why', p.rationale, '', '## Evidence', ...p.evidence.map((e) => `- ${e.summary} (${e.ref})`), '', '## Eval', p.evalPlan, '', '## Metric to move', p.metric, ''].join('\n');
}

export type Exec = (cmd: string, args: string[], cwd: string) => string;
const realExec: Exec = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Open one proposal as a draft PR from an isolated worktree. Returns the PR URL. */
export function openProposalPr(p: Proposal, repoDir: string, exec: Exec = realExec): string {
  const base = exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir).trim().replace(/^origin\//, '') || 'main';
  const branch = `improve/${p.id}-${slug(p.title)}`;
  if (branch === base) throw new Error('Refusing to write to the default branch.');
  const wt = join(tmpdir(), `phm-improve-${p.id}`);
  rmSync(wt, { recursive: true, force: true });
  exec('git', ['fetch', 'origin', base], repoDir);
  exec('git', ['worktree', 'add', '-b', branch, wt, `origin/${base}`], repoDir);
  try {
    mkdirSync(join(wt, 'workplans', 'proposals'), { recursive: true });
    writeFileSync(join(wt, 'workplans', 'proposals', `${p.id}.md`), renderProposal(p));
    exec('git', ['add', 'workplans/proposals'], wt);
    exec('git', ['commit', '-m', `proposal: ${p.title}`], wt);
    exec('git', ['push', '-u', 'origin', branch], wt);
    return exec('gh', ['pr', 'create', '--draft', '--base', base, '--head', branch, '--title', `proposal: ${p.title}`, '--body', renderProposal(p)], wt).trim();
  } finally {
    try { exec('git', ['worktree', 'remove', '--force', wt], repoDir); } catch { /* best effort */ }
  }
}
