/**
 * `ashlr fleet ci-triggers` — read-only workflow-trigger inventory for the
 * Nov 1 order (stop per-PR/push CI, run CI once daily). The only gh calls are
 * `gh api` GETs: repo metadata, the branch head sha, `actions/workflows`
 * pages and `contents/{path}?ref={sha}` — nothing is edited, disabled or
 * dispatched. The per-repo read is injected (CiTriggerReader) so the report
 * is unit-testable; the production reader wraps the bounded argv-only git-ops
 * runner like fleet-ship-gap. Workflow source never leaves the parse — only
 * event names and cron strings reach the report.
 *
 * Exit codes: 0 complete read, 1 unknown/unread/truncated evidence, 2 bad usage.
 */
import { tmpdir } from 'node:os';

import { defaultGitRunner } from '../core/verse/git-ops.js';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import {
  buildCiTriggerFacts,
  type CiTriggerReader,
  type CiTriggerRepoRead,
  type CiTriggerWorkflowItem,
} from '../core/fleet/ci-trigger-facts.js';
import { makeColors, isTty } from './ui.js';

const { bold, dim, red, yellow } = makeColors(isTty());

export const FLEET_CI_TRIGGERS_USAGE = 'ashlr fleet ci-triggers [--repo OWNER/REPO] [--json]';
const DEFAULT_REPO = 'ashlrai/phantom';

const GH_TIMEOUT_MS = 30_000, GH_API_MAX_BYTES = 4 * 1024 * 1024;
const WORKFLOW_PAGES = 2, MAX_WORKFLOW_BYTES = 512 * 1024;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/, SHA = /^[a-f0-9]{40}$/;

/** Production gh: argv only, bounded, never prompts (git-ops' runner and env). */
const defaultGh: CloudGh = async (args) => {
  const r = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: GH_TIMEOUT_MS, maxStdoutBytes: GH_API_MAX_BYTES,
  });
  return { ok: r.code === 0 && !r.timedOut && !r.truncated, stdout: r.stdout, stderr: r.stderr };
};

type GhJson = { ok: true; value: unknown } | { ok: false; reason: string };

/** One read-only `gh api <endpoint>` GET returning parsed JSON. */
async function ghApiJson(gh: CloudGh, endpoint: string): Promise<GhJson> {
  const result = await gh(['api', endpoint]);
  if (!result.ok) {
    const detail = result.stderr.split('\n').map((line) => line.trim()).find(Boolean);
    return { ok: false, reason: `gh api ${endpoint} failed${detail ? ` (${detail.slice(0, 200)})` : ''}` };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, reason: `gh api ${endpoint} did not return JSON` };
  }
}

/** Default-branch workflow source at the pinned sha; bounded base64 blob only. */
async function readWorkflowSource(gh: CloudGh, repo: string, path: string, sha: string): Promise<CiTriggerWorkflowItem['source']> {
  const file = await ghApiJson(gh, `repos/${repo}/contents/${path}?ref=${sha}`);
  if (!file.ok) return file;
  const b = file.value as { type?: unknown; encoding?: unknown; size?: unknown; content?: unknown };
  if (b.type !== 'file' || b.encoding !== 'base64' || !Number.isSafeInteger(b.size)
    || Number(b.size) < 1 || Number(b.size) > MAX_WORKFLOW_BYTES
    || typeof b.content !== 'string' || b.content.length > MAX_WORKFLOW_BYTES * 2) {
    return { ok: false, reason: 'unsupported workflow blob' };
  }
  const encoded = b.content.replace(/[\r\n]/g, '');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    return { ok: false, reason: 'invalid workflow blob base64' };
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== Number(b.size)) return { ok: false, reason: 'workflow blob size mismatch' };
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: 'workflow source is not utf-8' };
  }
}

/**
 * The production reader: repo metadata, the branch head sha, up to two
 * `actions/workflows` pages for enabled state, then one bounded contents GET
 * per workflow at that sha. Per-workflow source failures degrade to unread
 * rows; inventory failures fail the whole read.
 */
export function ghCiTriggerReader(gh: CloudGh): CiTriggerReader {
  return async (repo) => {
    const meta = await ghApiJson(gh, `repos/${repo}`);
    if (!meta.ok) return meta;
    const branch = (meta.value as { default_branch?: unknown }).default_branch;
    if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes('..')) {
      return { ok: false, reason: `gh api repos/${repo} did not name a usable default branch` };
    }
    const head = await ghApiJson(gh, `repos/${repo}/branches/${branch}`);
    if (!head.ok) return head;
    const sha = (head.value as { commit?: { sha?: unknown } }).commit?.sha;
    if (typeof sha !== 'string' || !SHA.test(sha)) {
      return { ok: false, reason: `gh api branches for ${repo} did not report the default-branch sha` };
    }
    const truncated: string[] = [], workflows: CiTriggerWorkflowItem[] = [], seen = new Set<string>();
    let total: number | null = null;
    for (let page = 1; page <= WORKFLOW_PAGES; page++) {
      const list = await ghApiJson(gh, `repos/${repo}/actions/workflows?per_page=100&page=${page}`);
      if (!list.ok) return list;
      const body = list.value as { total_count?: unknown; workflows?: unknown };
      if (!Number.isSafeInteger(body.total_count) || !Array.isArray(body.workflows)) {
        return { ok: false, reason: `gh api actions/workflows for ${repo} returned an invalid inventory` };
      }
      total = Number(body.total_count);
      for (const row of body.workflows) {
        const w = row as { path?: unknown; name?: unknown; state?: unknown } | null;
        const path = typeof w?.path === 'string' ? w.path : null;
        if (path === null || seen.has(path)) continue;
        seen.add(path);
        const name = typeof w?.name === 'string' ? w.name : null;
        const enabled = typeof w?.state !== 'string' ? null : w.state === 'active' ? true : w.state.startsWith('disabled') ? false : null;
        if (!WORKFLOW_PATH.test(path) || path.includes('..')) {
          workflows.push({ path: path.slice(0, 200), name, enabled, source: { ok: false, reason: 'unsupported workflow path' } });
          continue;
        }
        workflows.push({ path, name, enabled, source: await readWorkflowSource(gh, repo, path, sha) });
      }
      if (workflows.length >= total || body.workflows.length < 100) break;
    }
    if (total !== null && workflows.length < total) {
      truncated.push(`workflow inventory truncated at ${workflows.length}/${total}`);
    }
    return { ok: true, defaultBranch: branch, defaultBranchSha: sha, truncated, workflows };
  };
}

export interface FleetCiTriggersDeps {
  /** Injected per-repo reader; defaults to ghCiTriggerReader(gh ?? defaultGh). */
  reader?: CiTriggerReader;
  /** Injected gh; used only when reader is absent. */
  gh?: CloudGh;
  now?: () => Date;
}

export async function cmdFleetCiTriggers(args: string[], deps: FleetCiTriggersDeps = {}): Promise<number> {
  let repo = DEFAULT_REPO, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log(`usage: ${FLEET_CI_TRIGGERS_USAGE}`);
      return 0;
    }
    if (seen.has(arg)) {
      process.stderr.write(red('error: ') + `duplicate ${arg}\nusage: ${FLEET_CI_TRIGGERS_USAGE}\n`);
      return 2;
    }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--repo') repo = args[++i] ?? '';
    else {
      process.stderr.write(red('error: ') + `invalid argument ${arg}\nusage: ${FLEET_CI_TRIGGERS_USAGE}\n`);
      return 2;
    }
  }
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_.-]{1,100}$/.test(repo) || repo.split('/').some(s => s === '.' || s === '..')) {
    process.stderr.write(red('error: ') + `invalid --repo ${repo}\nusage: ${FLEET_CI_TRIGGERS_USAGE}\n`);
    return 2;
  }

  const reader = deps.reader ?? ghCiTriggerReader(deps.gh ?? defaultGh);
  let read: CiTriggerRepoRead;
  try {
    read = await reader(repo);
  } catch (error) {
    read = { ok: false, reason: `reader threw: ${error instanceof Error ? error.message : String(error)}` };
  }
  const report = buildCiTriggerFacts(repo, read, (deps.now ?? (() => new Date()))());

  if (json) {
    console.log(JSON.stringify(report));
  } else {
    const at = report.defaultBranchSha ? ` @ ${report.defaultBranchSha.slice(0, 12)} (${report.defaultBranch})` : '';
    console.log(bold('Fleet CI triggers:') + ` ${repo}${at} — ${report.scanned} workflow(s) read, ${report.unread} unread`);
    if (report.status === 'unknown') {
      console.log(red('inventory unknown: ') + (report.reason ?? 'unread'));
    }
    if (report.ownerReview.length > 0) {
      console.log(yellow('Owner review required') + ' — per-change CI triggers still declared (Nov 1 order: no per-PR/push CI, CI once daily):');
      for (const r of report.ownerReview) {
        console.log(`  ${r.path}${r.name ? ` (${r.name})` : ''}: ${r.flags.join(', ')} — workflow trigger edits need owner action`);
      }
    }
    for (const w of report.workflows) {
      const state = w.enabled === null ? 'enabled?' : w.enabled ? 'enabled' : 'disabled';
      const detail = w.read === 'ok'
        ? `events=${w.events.join('|') || 'none'} cron=${w.schedules.join('|') || 'none'} daily=${w.dailySchedules.join('|') || 'none'} manual/reusable=${w.manualOrReusable.join('|') || 'none'}`
        : `${w.read}: ${w.error}`;
      console.log(`  ${w.path} [${state}, ${w.classification}] ${detail}${w.flags.length > 0 ? ' ' + yellow(`flags=${w.flags.join(',')}`) : ''}`);
    }
    for (const t of report.truncated) console.log(yellow(`truncated: ${t}`));
    for (const c of report.caveats) console.log(dim(`note: ${c}`));
  }
  return report.status === 'unknown' || report.unread > 0 || report.truncated.length > 0 ? 1 : 0;
}
