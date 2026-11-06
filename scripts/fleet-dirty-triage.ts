/**
 * tsx scripts/fleet-dirty-triage.ts [--repo owner/name]... [--stale-days N]
 * tsx scripts/fleet-dirty-triage.ts --superseded [--repo owner/name]...
 *
 * Read-only JSON triage for a repo's open DIRTY pull requests.
 *
 * Default mode ranks each DIRTY PR as superseded (patch already on base),
 * recut-worthy, or stale, each with a C1-C6 reason. Ranking is recut-worthy,
 * then superseded, then stale; numbers break ties. It reads GitHub through
 * `locus exec -- gh`, which needs a pinned Locus identity.
 *
 * --superseded mode needs only `gh` (no Locus pin). For each open DIRTY PR it
 * compares the contents of every file the PR touches at the PR head against
 * the base tip and prints the number, a verdict and the evidence:
 *   superseded  every changed file's head content already equals the base tip
 *   partial     some changed files match the base tip, others still differ
 *   diverged    no changed file matches (e.g. the file is deleted on base)
 *   unreadable  the PR head or its diff could not be read
 *
 * Both modes never close, comment, push or mutate in any way: every GitHub
 * access is a GET (`gh pr list`, and `gh api` calls without --method).
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface DirtyPull {
  number: number; title: string; url: string; state: string; isDraft: boolean;
  isCrossRepository: boolean; autoMergeRequest: unknown;
  mergeStateStatus: string; headRefOid: string;
  headRepository: { nameWithOwner?: string } | null;
  baseRefName: string; baseRefOid?: string; updatedAt: string;
}
const fields = "number,title,url,state,isDraft,isCrossRepository,autoMergeRequest,mergeStateStatus,headRefOid,headRepository,baseRefName,baseRefOid,updatedAt";
const SHA = /^[a-f0-9]{40}$/;
const DAY = 86_400_000;
const REPO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const USAGE = "Usage: tsx scripts/fleet-dirty-triage.ts [--superseded] [--repo owner/name]... [--stale-days N]";

export const REASONS = {
  C1: "patch already on base: head tree identical to, or fully contained in, base",
  C2: "patch already on base: head tip landed via a merged sibling PR",
  C3: "stale: head fork or ref unavailable; a recut is impossible",
  C4: "stale: no activity within --stale-days and no automerge armed",
  C5: "recut-worthy: automerge armed; a recut unblocks the merge",
  C6: "recut-worthy: unique patch with recent activity; recut candidate",
} as const;
export type ReasonCode = keyof typeof REASONS;
export type TriageClass = "superseded" | "recut-worthy" | "stale";
const CLASS_OF: Record<ReasonCode, TriageClass> = { C1: "superseded", C2: "superseded", C3: "stale", C4: "stale", C5: "recut-worthy", C6: "recut-worthy" };
const RANK: Record<ReasonCode, number> = { C5: 0, C6: 1, C1: 2, C2: 3, C4: 4, C3: 5 };

export interface Compare { status?: string; ahead_by?: number; behind_by?: number }
export interface Verdict { class: TriageClass; reason: ReasonCode; detail: string }
export function verdict(pr: DirtyPull, ctx: {
  now: number; staleDays: number;
  compare?: Compare | null;   // base..head two-dot compare, null when never fetched
  sibling?: number | null;    // merged PR that introduced the head tip, null when none
}): Verdict {
  const cls = (reason: ReasonCode, detail: string): Verdict => ({ class: CLASS_OF[reason], reason, detail });
  if (!pr.headRepository) return cls("C3", "head fork deleted");
  if (!SHA.test(pr.headRefOid)) return cls("C3", "head ref unavailable");
  const cmp = ctx.compare;
  const shape = cmp && typeof cmp.ahead_by === "number" ? `; ${cmp.ahead_by} ahead/${cmp.behind_by ?? "?"} behind` : "";
  if (cmp && (cmp.status === "identical" || cmp.ahead_by === 0))
    return cls("C1", `base..head ${cmp.status ?? "contained"}${shape}`);
  if (ctx.sibling != null) return cls("C2", `head tip landed via merged PR #${ctx.sibling}`);
  if (pr.autoMergeRequest) return cls("C5", `automerge armed${shape}`);
  const age = ctx.now - Date.parse(pr.updatedAt || "");
  const days = Number.isFinite(age) ? Math.max(0, Math.floor(age / DAY)) : NaN;
  if (Number.isFinite(age) && age >= ctx.staleDays * DAY)
    return cls("C4", `inactive ${days}d >= ${ctx.staleDays}d${shape}`);
  const when = !Number.isFinite(days) ? "recently" : days === 0 ? "today" : `${days}d ago`;
  return cls("C6", `unique patch, updated ${when}${shape}`);
}

export interface TriageItem extends Verdict {
  rank: number; number: number; title: string; url: string;
  isDraft: boolean; isCrossRepository: boolean;
  updatedAt: string; headRefOid: string; aheadBy?: number; behindBy?: number;
}
export interface RepoTriage {
  repo: string; scanned: number; dirty: number; truncated: boolean;
  counts: Record<TriageClass, number>;
  prs: TriageItem[]; errors: { number: number; stage: string }[];
}
export interface TriageReport {
  generatedAt: string; staleDays: number; truncated: boolean;
  counts: Record<TriageClass, number> & { errors: number };
  reasons: typeof REASONS; repos: RepoTriage[];
}

export type Gh = (args: string[]) => Promise<string>;

// Locate a CLI ourselves instead of letting child_process search PATH at exec
// time (Sonar S4036): PATH directories in execvp order, then the standard
// install locations, spawned by absolute path. `.cmd`/`.bat` shims are
// intentionally skipped: exec'ing them requires a shell.
function resolveExecutable(name: string): string | null {
  const isWindows = platform() === "win32";
  const names = isWindows ? [`${name}.exe`, `${name}.com`] : [name];
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const fallbacks = [join(home, ".cargo", "bin"), join(home, ".local", "bin")];
  if (!isWindows) fallbacks.push("/usr/local/bin", "/opt/homebrew/bin");
  for (const dir of fallbacks) if (!dirs.includes(dir)) dirs.push(dir);
  for (const dir of dirs) {
    for (const exe of names) {
      const candidate = resolve(dir, exe);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!isWindows) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch { /* not here or not executable */ }
    }
  }
  return null;
}

const locusGh: Gh = async args => {
  const locus = resolveExecutable("locus");
  if (!locus) throw new Error("locus CLI not found on PATH or standard install dirs");
  return execFileSync(locus, ["exec", "--", "gh", ...args], {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
};

// --superseded mode's runner: plain `gh`, no Locus pin required.
const plainGh: Gh = async args => {
  const gh = resolveExecutable("gh");
  if (!gh) throw new Error("gh CLI not found on PATH or standard install dirs");
  return execFileSync(gh, args, {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
};

function parseArgs(argv: string[]): { repos: string[]; staleDays: number; superseded: boolean } {
  const repos: string[] = [];
  let staleDays = 14, superseded = false;
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1] ?? "";
    if (argv[i] === "--repo" && REPO_NAME.test(next)) repos.push(argv[++i]!);
    else if (argv[i] === "--stale-days" && /^[1-9]\d{0,2}$/.test(next) && Number(next) <= 365) staleDays = Number(argv[++i]);
    else if (argv[i] === "--superseded") superseded = true;
    else throw new Error(USAGE);
  }
  return { repos, staleDays, superseded };
}

async function listOpenPulls(gh: Gh, repo: string, explicit: boolean): Promise<DirtyPull[]> {
  return JSON.parse(await gh(["pr", "list",
    ...(explicit ? ["--repo", repo] : []), "--state", "open", "--limit", "1000", "--json", fields]));
}

async function resolveTargets(gh: Gh, repos: string[]): Promise<string[]> {
  if (repos.length) return repos;
  const self = JSON.parse(await gh(["api", "repos/{owner}/{repo}"])) as { full_name?: string };
  return [self.full_name ?? "current"];
}

const apiBase = (repo: string, explicit: boolean) => `repos/${explicit ? repo : "{owner}/{repo}"}`;

export async function fleetDirtyTriage(argv: string[],
  deps = { gh: locusGh, now: () => Date.now() }): Promise<TriageReport> {
  const { repos, staleDays } = parseArgs(argv);
  const now = deps.now();
  const report: TriageReport = {
    generatedAt: new Date(now).toISOString(), staleDays, truncated: false,
    counts: { "recut-worthy": 0, superseded: 0, stale: 0, errors: 0 },
    reasons: REASONS, repos: [],
  };
  for (const repo of await resolveTargets(deps.gh, repos)) {
    const explicit = repos.length > 0;
    const base = apiBase(repo, explicit);
    const prs = await listOpenPulls(deps.gh, repo, explicit);
    const out: RepoTriage = {
      repo, scanned: prs.length, dirty: 0, truncated: prs.length === 1000,
      counts: { "recut-worthy": 0, superseded: 0, stale: 0 }, prs: [], errors: [],
    };
    for (const pr of prs.filter(p => p.state === "OPEN" && p.mergeStateStatus === "DIRTY")) {
      out.dirty++;
      let stage = "classify", compare: Compare | null = null, sibling: number | null = null;
      try {
        if (pr.headRepository && SHA.test(pr.headRefOid)) {
          stage = "compare";
          const baseRef = SHA.test(pr.baseRefOid ?? "") ? pr.baseRefOid! : pr.baseRefName;
          const fetched: Compare = JSON.parse(await deps.gh(["api", `${base}/compare/${baseRef}..${pr.headRefOid}`]));
          compare = fetched;
          if (!(fetched.status === "identical" || fetched.ahead_by === 0)) {
            stage = "pulls";
            const pulls: { number: number; merged_at: string | null }[] =
              JSON.parse(await deps.gh(["api", "--paginate", `${base}/commits/${pr.headRefOid}/pulls`]));
            sibling = pulls.find(p => p.merged_at && p.number !== pr.number)?.number ?? null;
          }
        }
        const v = verdict(pr, { now, staleDays, compare, sibling });
        out.prs.push({ ...v, rank: 0, number: pr.number, title: pr.title, url: pr.url,
          isDraft: pr.isDraft, isCrossRepository: pr.isCrossRepository,
          updatedAt: pr.updatedAt, headRefOid: pr.headRefOid,
          aheadBy: compare?.ahead_by, behindBy: compare?.behind_by });
        out.counts[v.class]++; report.counts[v.class]++;
      } catch {
        // Command errors may carry credentials; only the stage is reported.
        out.errors.push({ number: pr.number, stage });
        report.counts.errors++;
      }
    }
    out.prs.sort((a, b) => RANK[a.reason] - RANK[b.reason] || a.number - b.number);
    out.prs.forEach((pr, i) => { pr.rank = i + 1; });
    report.truncated ||= out.truncated;
    report.repos.push(out);
  }
  return report;
}

// --superseded mode -----------------------------------------------------------

export const SUPERSEDED_VERDICTS = {
  superseded: "every changed file's head content already equals the base tip",
  partial: "some changed files match the base tip; others still differ",
  diverged: "no changed file matches the base tip (e.g. deleted on base)",
  unreadable: "the PR head or its diff could not be read",
} as const;
export type SupersededVerdict = keyof typeof SUPERSEDED_VERDICTS;
const VERDICT_ORDER: Record<SupersededVerdict, number> = { superseded: 0, partial: 1, diverged: 2, unreadable: 3 };
// The compare endpoint caps its file list; a capped list would misreport
// unreturned paths as matched, so it is treated as unreadable instead.
const COMPARE_FILE_CAP = 300;

export interface PullFile { filename: string; status?: string }
export interface CompareWithFiles extends Compare {
  files?: { filename: string; status?: string }[];
}
export interface SupersededEvidence {
  changedFiles: number;                          // files the PR touches
  matched: string[];                             // head content identical to base tip
  differing: { path: string; status: string }[]; // still differ; status is base→head
  compareStatus?: string; aheadBy?: number; behindBy?: number;
  note?: string;                                 // why a PR is unreadable
}
export interface SupersededItem {
  number: number; title: string; url: string;
  verdict: SupersededVerdict; evidence: SupersededEvidence;
}
export interface SupersededRepo {
  repo: string; scanned: number; dirty: number; truncated: boolean;
  counts: Record<SupersededVerdict, number>; prs: SupersededItem[];
}
export interface SupersededReport {
  generatedAt: string; mode: "superseded"; truncated: boolean;
  counts: Record<SupersededVerdict, number>;
  verdicts: typeof SUPERSEDED_VERDICTS; repos: SupersededRepo[];
}

export function supersededVerdict(matched: number, differing: number): SupersededVerdict {
  if (differing === 0) return "superseded";
  return matched === 0 ? "diverged" : "partial";
}

/** Every file the PR touches, streamed as NDJSON across all result pages. */
export async function pullChangedFiles(gh: Gh, base: string, prNumber: number): Promise<PullFile[]> {
  const out = await gh(["api", "--paginate", "--jq", ".[]", `${base}/pulls/${prNumber}/files?per_page=100`]);
  const lines = out.split("\n").map(l => l.trim()).filter(Boolean);
  return lines.map(line => JSON.parse(line) as PullFile);
}

export async function fleetDirtySuperseded(argv: string[],
  deps = { gh: plainGh, now: () => Date.now() }): Promise<SupersededReport> {
  const { repos } = parseArgs(argv);
  const now = deps.now();
  const report: SupersededReport = {
    generatedAt: new Date(now).toISOString(), mode: "superseded", truncated: false,
    counts: { superseded: 0, partial: 0, diverged: 0, unreadable: 0 },
    verdicts: SUPERSEDED_VERDICTS, repos: [],
  };
  for (const repo of await resolveTargets(deps.gh, repos)) {
    const explicit = repos.length > 0;
    const base = apiBase(repo, explicit);
    const prs = await listOpenPulls(deps.gh, repo, explicit);
    const out: SupersededRepo = {
      repo, scanned: prs.length, dirty: 0, truncated: prs.length === 1000,
      counts: { superseded: 0, partial: 0, diverged: 0, unreadable: 0 }, prs: [],
    };
    for (const pr of prs.filter(p => p.state === "OPEN" && p.mergeStateStatus === "DIRTY")) {
      out.dirty++;
      const evidence: SupersededEvidence = { changedFiles: 0, matched: [], differing: [] };
      let v: SupersededVerdict = "unreadable", stage = "head";
      try {
        if (!pr.headRepository || !SHA.test(pr.headRefOid)) throw new Error("unreadable");
        const baseRef = SHA.test(pr.baseRefOid ?? "") ? pr.baseRefOid! : pr.baseRefName;
        stage = "compare";
        const cmp: CompareWithFiles = JSON.parse(await deps.gh(["api", `${base}/compare/${baseRef}..${pr.headRefOid}`]));
        const contained = cmp.status === "identical" || cmp.ahead_by === 0;
        if (!cmp.files && !contained) { evidence.note = "compare response has no file list"; throw new Error("unreadable"); }
        if ((cmp.files?.length ?? 0) >= COMPARE_FILE_CAP) { evidence.note = `compare file list capped at ${COMPARE_FILE_CAP}`; throw new Error("unreadable"); }
        stage = "files";
        const changed = await pullChangedFiles(deps.gh, base, pr.number);
        const diffStatus = new Map((cmp.files ?? []).map(f => [f.filename, f.status ?? "modified"]));
        evidence.changedFiles = changed.length;
        evidence.compareStatus = cmp.status; evidence.aheadBy = cmp.ahead_by; evidence.behindBy = cmp.behind_by;
        for (const f of changed) {
          const status = diffStatus.get(f.filename);
          if (status === undefined) evidence.matched.push(f.filename);
          else evidence.differing.push({ path: f.filename, status });
        }
        v = supersededVerdict(evidence.matched.length, evidence.differing.length);
      } catch {
        // Command errors may carry credentials; only the stage is reported.
        evidence.note ??= `${stage} unreadable`;
      }
      out.prs.push({ number: pr.number, title: pr.title, url: pr.url, verdict: v, evidence });
      out.counts[v]++; report.counts[v]++;
    }
    out.prs.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.number - b.number);
    report.truncated ||= out.truncated;
    report.repos.push(out);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const argv = process.argv.slice(2);
    const out = argv.includes("--superseded")
      ? await fleetDirtySuperseded(argv)
      : await fleetDirtyTriage(argv);
    console.log(JSON.stringify(out));
  } catch {
    console.error("fleet-dirty-triage: invalid arguments or discovery failure");
    process.exitCode = 1;
  }
}
