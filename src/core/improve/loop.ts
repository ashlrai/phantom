/**
 * Self-improvement proposal loop: turn evidence into proposals and open them as
 * draft PRs. Merging remains on the existing protected approval path. It
 * never pushes to the default branch, never uses --admin and never tags/deploys.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, lstatSync, realpathSync, rmdirSync,
  openSync, closeSync, fstatSync, readFileSync, constants, type Stats } from 'node:fs';
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

function evidenceRepository(ref: string): string | null {
  const match = /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]+)\/(issues|pull|commit|discussions|actions\/runs)\/[\w-]+(#[\w-]+)?$/i.exec(ref);
  return match && !['.', '..'].includes(match[2]!) ? `${match[1]}/${match[2]}` : null;
}

/** URL syntax alone cannot prove visibility; an unverified reference is private. */
export function isPublicEvidenceRef(ref: string, publicRepositories: ReadonlySet<string> = new Set()): boolean {
  const repo = evidenceRepository(ref);
  return repo !== null && publicRepositories.has(repo.toLowerCase());
}
function publicEvidence(ev: Evidence[], publicRepositories: ReadonlySet<string> = new Set()): Evidence[] {
  const pub = ev.filter((e) => isPublicEvidenceRef(e.ref, publicRepositories)).map((e) => ({ ref: e.ref, summary: 'public evidence' }));
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
    const rationale = `${r.id} is over its quota (${Math.round(r.bytes / 1048576)} MB).`;
    const evidence = [{ ref: `steward:${r.id}`, summary: `${r.files} files, reclaimable ${Math.round(r.reclaimable.bytes / 1048576)} MB` }];
    out.push({ id: pid(title), title, rationale: 'An allowlisted agent-log root exceeds its configured quota (local measurements withheld).', evidence: publicEvidence(evidence), local: { title, rationale, evidence }, evalPlan: 'Steward fixture shows the root stays under quota for 30 simulated days.', metric: 'agent log disk usage' });
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

/** Local render does not authorize publishing URLs: visibility remains unknown. */
export function renderPublicProposal(p: Proposal): string {
  return publicBody(p, new Set());
}
function publicBody(p: Proposal, publicRepositories: ReadonlySet<string>): string {
  return scrubSecrets(renderProposal({ ...p, local: undefined,
    evidence: publicEvidence(p.local?.evidence ?? p.evidence, publicRepositories) }));
}

export type Exec = (cmd: string, args: string[], cwd: string) => string;
const realExec: Exec = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Drafts only. This loop has no standing-policy/protected-merge admission. */
export interface OpenPrOptions { /** Refused before any effect; use the existing protected merge process. */ autoMerge?: boolean }

function assertProposal(p: Proposal): void {
  if (!p || typeof p.id !== 'string' || !/^[a-f0-9]{10}$/.test(p.id)) throw new Error('Invalid proposal id.');
  for (const key of ['title', 'rationale', 'evalPlan', 'metric'] as const) {
    if (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > (key === 'title' ? 200 : 4000)) throw new Error('Invalid public proposal field.');
  }
  for (const evidence of [p.evidence, ...(p.local ? [p.local.evidence] : [])]) {
    if (!Array.isArray(evidence) || evidence.length > 100 || evidence.some((e) =>
      !e || typeof e.ref !== 'string' || e.ref.length > 500 || typeof e.summary !== 'string' || e.summary.length > 1000)) throw new Error('Invalid proposal evidence.');
  }
}

function publicRepositories(p: Proposal, repoDir: string, exec: Exec): Set<string> {
  const verified = new Set<string>();
  const candidates = new Set((p.local?.evidence ?? p.evidence).map((e) => evidenceRepository(e.ref)).filter((r): r is string => r !== null));
  for (const repo of candidates) {
    try {
      // Read only public-status fields: never return repository settings or credentials.
      const result = JSON.parse(exec('gh', ['api', `repos/${repo}`, '--jq', '{full_name, private, visibility}'], repoDir)) as Record<string, unknown>;
      if (result && typeof result.full_name === 'string' && result.full_name.toLowerCase() === repo.toLowerCase() &&
          result.private === false && result.visibility === 'public') verified.add(repo.toLowerCase());
    } catch { /* Unknown visibility is not public evidence. */ }
  }
  return verified;
}

const sameDirectory = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
function pinDirectory(path: string): Stats {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(path) !== path ||
      (process.getuid && st.uid !== process.getuid()) || (process.platform !== 'win32' && (st.mode & 0o022) !== 0)) throw new Error('Proposal directory custody changed.');
  return st;
}
function assertDirectory(path: string, pinned: Stats): void {
  if (!sameDirectory(pinDirectory(path), pinned)) throw new Error('Proposal directory custody changed.');
}

/** Open a draft from a unique worktree owned by this invocation. */
export function openProposalPr(p: Proposal, repoDir: string, exec: Exec = realExec, opts: OpenPrOptions = {}): string {
  if (opts.autoMerge) throw new Error('Self-improvement auto-merge lacks protected-policy admission. Open a draft and use the existing protected merge process.');
  assertProposal(p); // Before any filesystem or subprocess operation.
  // Snapshot the admitted data; callbacks cannot replace ids or evidence mid-effect.
  p = { ...p, evidence: p.evidence.map((e) => ({ ...e })),
    ...(p.local ? { local: { ...p.local, evidence: p.local.evidence.map((e) => ({ ...e })) } } : {}) };
  const title = scrubSecrets(p.title);
  const remoteHead = exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir).trim();
  const base = remoteHead.startsWith('origin/') ? remoteHead.slice('origin/'.length) : '';
  if (!base || base.startsWith('-')) throw new Error('An exact valid origin default branch is required.');
  exec('git', ['check-ref-format', `refs/heads/${base}`], repoDir);
  const branch = `improve/${p.id}-${slug(title)}`;
  if (branch === base) throw new Error('Refusing to write to the default branch.');
  const parent = realpathSync(tmpdir());
  const container = mkdtempSync(join(parent, 'phm-improve-'));
  const containerPin = pinDirectory(container);
  // POSIX modes are checked where meaningful; Windows ACLs are not inferred from mode bits.
  if (process.platform !== 'win32' && (containerPin.mode & 0o777) !== 0o700) throw new Error('Proposal scratch directory must be private.');
  const wt = join(container, 'checkout');
  let addAttempted = false;
  let worktreePin: Stats | undefined;
  const directories = new Map<string, Stats>([[container, containerPin]]);
  let artifact: { path: string; stat: Stats; body: string } | undefined;
  const current = () => {
    assertProposal(p);
    for (const [path, pin] of directories) assertDirectory(path, pin);
    if (artifact) {
      const st = lstatSync(artifact.path);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.dev !== artifact.stat.dev || st.ino !== artifact.stat.ino ||
          st.size !== artifact.stat.size || st.mtimeMs !== artifact.stat.mtimeMs || st.ctimeMs !== artifact.stat.ctimeMs) throw new Error('Proposal artifact custody changed.');
      const fd = openSync(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (opened.dev !== st.dev || opened.ino !== st.ino || readFileSync(fd, 'utf8') !== artifact.body) throw new Error('Proposal artifact custody changed.');
      } finally { closeSync(fd); }
    }
  };
  const run = (cmd: string, args: string[]) => { current(); return exec(cmd, args, wt); };
  try {
    assertDirectory(container, containerPin);
    exec('git', ['fetch', 'origin', base], repoDir);
    assertDirectory(container, containerPin);
    addAttempted = true;
    exec('git', ['worktree', 'add', '-b', branch, wt, `origin/${base}`], repoDir);
    worktreePin = pinDirectory(wt);
    directories.set(wt, worktreePin);
    let path = wt;
    for (const component of ['workplans', 'proposals']) {
      current();
      path = join(path, component);
      try { lstatSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(path, { mode: 0o700 });
      }
      directories.set(path, pinDirectory(path));
    }
    current();
    const readVisibility = () => publicRepositories(p, wt, (cmd, args, cwd) => { current(); return exec(cmd, args, cwd); });
    const body = publicBody({ ...p, title }, readVisibility());
    const visibilityCurrent = () => {
      // Visibility is mutable: re-read before each public effect, not a durable grant.
      if (publicBody({ ...p, title }, readVisibility()) !== body) throw new Error('Evidence visibility changed before publication.');
    };
    current();
    const file = join(path, `${p.id}.md`);
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, body); artifact = { path: file, stat: fstatSync(fd), body }; }
    finally { closeSync(fd); }
    current();
    run('git', ['add', `workplans/proposals/${p.id}.md`]);
    run('git', ['commit', '-m', `proposal: ${title}`]);
    visibilityCurrent();
    run('git', ['push', '-u', 'origin', branch]);
    visibilityCurrent();
    return run('gh', ['pr', 'create', '--draft', '--base', base, '--head', branch,
      '--title', `proposal: ${title}`, '--body', body]).trim();
  } finally {
    try {
      assertDirectory(container, containerPin);
      if (worktreePin) {
        assertDirectory(wt, worktreePin);
        // Git refuses dirty/locked worktrees; do not force away newer work.
        exec('git', ['worktree', 'remove', wt], repoDir);
      }
      if (worktreePin || !addAttempted) {
        assertDirectory(container, containerPin);
        rmdirSync(container); // Empty acquired container only; never recursive cleanup.
      } // Uncertain worktree-add state is retained, even when it looks empty.
    } catch { /* Retain uncertain or changed state for explicit inspection. */ }
  }
}
