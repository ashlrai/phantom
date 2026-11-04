import { execFile } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { readRunsSwitches } from '../fleet/runs-switches.js';

export const AUTONOMY_REPOS = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-plugin', 'ashlr-stack', 'ashlr-md'] as const;
type Classification = 'cut' | 'automate' | 'hard-limit';
type Status = 'human step' | 'gate (keep)' | 'ok' | 'unknown';
export interface AutonomyGate { id: string; where: string; kind: string; classification: Classification; reason: string }
export interface AuditItem { id: string; status: Status; detail: string }
export interface RepoAudit { repo: string; defaultBranch: string | null; allowAutoMerge: boolean | null; mergeQueue: boolean | null; rulesets: unknown; environments: unknown; workflows: unknown; autoTag: { exists: boolean | null; conclusion: string | null }; publishHold: boolean | null; items: AuditItem[] }
export interface AutonomyReport { repos: RepoAudit[]; gates: AutonomyGate[]; complete: boolean }
export interface AuditOptions { repo?: string; read?: (endpoint: string) => Promise<unknown>; publishHold?: { on: boolean | null; sourceState: string } }
export class GitHubNotFoundError extends Error { constructor() { super('GitHub resource not found'); } }
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string | null => typeof v === 'string' ? v : null;
const gate = (id: string, where: string, kind: string, classification: Classification, reason: string): AutonomyGate => ({ id, where, kind, classification, reason });

// This list records policy and source locations, not observations that a gate is active.
const POLICY: AutonomyGate[] = [
  gate('secret-gate', 'scrub.pl, secret-shape gate, publish.sh', 'security pin', 'hard-limit', 'Protects secrets from exposure.'),
  gate('secret-workflows', 'workflow diffs', 'security review', 'hard-limit', 'Protects secrets from exposure.'),
  gate('sandbox-profiles', 'sandbox profiles', 'security pin', 'hard-limit', 'Protects secrets from untrusted execution.'),
  gate('leader-loop-denies', 'leader wrappers', 'security control', 'hard-limit', 'Protects secrets from untrusted execution.'),
  gate('maccu', 'MACCU TCC helper and loopback auth', 'security control', 'hard-limit', 'Protects access to private data and secrets.'),
  gate('confirmedByMason', 'outreach', 'send approval', 'hard-limit', 'Protects messages to people outside the team.'),
  gate('no-spend', 'fleet policy', 'spending', 'hard-limit', 'Protects money and billing.'),
  gate('codex-auth', '~/.codex', 'credential protection', 'hard-limit', 'Protects secrets and credentials.'),
  gate('publish-hold', 'src/core/fleet/runs-switches.ts; contrib/mac/dispatchd.py', 'publication hold', 'automate', 'Automatically resume publication when the backlog recovers.'),
  gate('g1-manual-merge', 'G1 manual merge', 'manual merge', 'automate', 'Use the merge queue and machine-verified checks.'),
  gate('g1-code-pin', 'G1-CODE-PIN', 'manual pin', 'cut', 'Remove manual code pins outside secret-protecting controls.'),
  gate('prompt-pins', 'prompts, lock scripts, plists and dispatchd.py', 'manual pin', 'cut', 'Remove manual pins while retaining secret-protecting controls.'),
  gate('dependency-parking', 'contrib/mac/restock.py', 'parking', 'automate', 'Unpark automatically when dependency results are verified.'),
  gate('merge-rate-parking', 'fleet queue', 'parking', 'automate', 'Automatically recover parked lanes when measured health recovers.'),
  gate('release-please', 'release-please workflow', 'release', 'automate', 'Automatically merge eligible release PRs after machine checks.'),
  gate('finalize-dispatch', 'finalize-github-release.yml', 'workflow dispatch', 'automate', 'Dispatch finalization after verified release prerequisites.'),
  gate('locus-ci', 'locus release.yml', 'workflow dispatch', 'automate', 'Run required release CI automatically after the qualifying event.'),
  gate('attest', 'release attestations', 'attestation', 'automate', 'Generate and verify attestations automatically; retain the gate.'),
];

async function githubRead(endpoint: string): Promise<unknown> {
  if (!/^repos\/ashlrai\/(?:phantom|phantom-secrets|locus|lexicon|ashlr-plugin|ashlr-stack|ashlr-md)(?:\/[A-Za-z0-9_./?=&%-]+)?$/.test(endpoint) || endpoint.includes('..')) throw new Error('Invalid GitHub endpoint');
  const out = await new Promise<string>((resolve, reject) => execFile('gh', ['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', endpoint], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } }, (error, stdout, stderr) => error ? reject(/HTTP 404\b/.test(stderr) ? new GitHubNotFoundError() : new Error('GitHub read unavailable')) : resolve(stdout)));
  return JSON.parse(out) as unknown;
}
async function pages(read: (endpoint: string) => Promise<unknown>, path: string, key?: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = await read(`${path}?per_page=100&page=${page}`);
    const rows = key ? obj(result)[key] : result;
    if (!Array.isArray(rows)) throw new Error('Malformed GitHub list');
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new Error('GitHub list pagination limit reached');
}
const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch { return null; } };
function triggers(content: unknown): string[] | null {
  try {
    const row = obj(content);
    if (row['encoding'] !== 'base64' || typeof row['content'] !== 'string') return null;
    const data = obj(parseYaml(Buffer.from(row['content'], 'base64').toString('utf8')));
    const on = data['on'];
    if (typeof on === 'string') return [on];
    if (Array.isArray(on)) return on.filter((v): v is string => typeof v === 'string');
    return Object.keys(obj(on));
  } catch { return null; }
}

export async function auditAutonomy(options: AuditOptions = {}): Promise<AutonomyReport> {
  const name = options.repo?.replace(/^ashlrai\//, '');
  if (name && !AUTONOMY_REPOS.some((r) => r === name)) throw new Error('Unknown enrolled repository');
  const read = options.read ?? githubRead;
  const switchState = options.publishHold ?? await (async () => { const state = await readRunsSwitches(); return { on: state.sourceState === 'healthy' ? state.switches.find((s) => s.id === 'PUBLISH_HOLD')?.on ?? null : null, sourceState: state.sourceState }; })();
  const gates = POLICY.map((row) => ({ ...row }));
  const repos: RepoAudit[] = [];
  let complete = switchState.on !== null;
  for (const repo of AUTONOMY_REPOS.filter((r) => !name || r === name)) {
    const base = `repos/ashlrai/${repo}`;
    const [info, ruleList, envList, workflowList] = await Promise.all([
      safe(() => read(base)), safe(() => pages(read, `${base}/rulesets`)), safe(() => pages(read, `${base}/environments`, 'environments')), safe(() => pages(read, `${base}/actions/workflows`, 'workflows')),
    ]);
    const branch = str(obj(info)['default_branch']);
    const protection = branch ? await safe(() => read(`${base}/branches/${encodeURIComponent(branch)}/protection`)) : null;
    const effectiveRules = branch ? await safe(() => pages(read, `${base}/rules/branches/${encodeURIComponent(branch)}`)) : null;
    const rules = ruleList === null ? null : await Promise.all(ruleList.map(async (r) => { const id = obj(r)['id']; return typeof id === 'number' ? await safe(() => read(`${base}/rulesets/${id}`)) : null; }));
    const ruleComplete = rules !== null && rules.every((r) => r !== null && Array.isArray(obj(r)['rules']));
    const activeRules = rules?.filter((r) => obj(r)['enforcement'] === 'active') ?? [];
    const branchRules = activeRules.filter((r) => {
      const row = obj(r); if (row['target'] !== 'branch' || !branch) return false;
      const refs = obj(obj(row['conditions'])['ref_name']);
      const includes = arr(refs['include']); const excludes = arr(refs['exclude']);
      return (includes.includes('~ALL') || includes.includes('~DEFAULT_BRANCH') || includes.includes(`refs/heads/${branch}`)) && !excludes.includes('~DEFAULT_BRANCH') && !excludes.includes(`refs/heads/${branch}`);
    });
    const uncertainBranchRules = activeRules.some((r) => {
      const row = obj(r); if (row['target'] !== 'branch') return false;
      const refs = obj(obj(row['conditions'])['ref_name']);
      return !Array.isArray(refs['include']) || !Array.isArray(refs['exclude']) || [...arr(refs['include']), ...arr(refs['exclude'])].some((ref) => typeof ref !== 'string' || ref.includes('*'));
    });
    const queueFound = branchRules.some((r) => arr(obj(r)['rules']).some((rule) => obj(rule)['type'] === 'merge_queue'));
    const queue = effectiveRules !== null ? effectiveRules.some((r) => obj(r)['type'] === 'merge_queue') : !ruleComplete || !branch || (!queueFound && uncertainBranchRules) ? null : queueFound;
    const items: AuditItem[] = [];
    const add = (id: string, status: Status, detail: string): void => { items.push({ id, status, detail }); };
    const allow = typeof obj(info)['allow_auto_merge'] === 'boolean' ? obj(info)['allow_auto_merge'] as boolean : null;
    add('auto-merge', allow === null ? 'unknown' : allow ? 'ok' : 'human step', allow === null ? 'Unavailable' : allow ? 'Enabled' : 'Disabled');
    add('merge-queue', queue === null ? 'unknown' : queue ? 'gate (keep)' : 'ok', queue === null ? 'Rulesets unavailable' : queue ? 'Default branch merge queue observed' : 'No active merge queue ruleset observed');
    add('required-checks', protection === null ? 'unknown' : 'gate (keep)', protection === null ? 'Branch protection unavailable' : 'Retain required checks');
    add('attest', 'gate (keep)', 'Retain release attestations');
    add('publish-hold', switchState.on === null ? 'unknown' : switchState.on ? 'human step' : 'ok', switchState.on === null ? `Unavailable (${switchState.sourceState})` : switchState.on ? 'PUBLISH_HOLD is set' : 'PUBLISH_HOLD is clear');
    const reviews = obj(obj(protection)['required_pull_request_reviews']);
    if (!ruleComplete) add('rulesets', 'unknown', 'Ruleset details unavailable');
    if (protection === null) add('approving-reviews', 'unknown', 'Branch protection unavailable');
    if (typeof reviews['required_approving_review_count'] === 'number' && reviews['required_approving_review_count'] > 0) add('approving-reviews', 'human step', `${reviews['required_approving_review_count']} required approvals`);
    if (rules) for (const r of rules) {
      if (r === null) continue;
      const row = obj(r); const label = str(row['name']) ?? 'Unnamed ruleset';
      const types = arr(row['rules']).map((x) => str(obj(x)['type'])).filter((x): x is string => x !== null);
      if (row['target'] === 'tag') add(`ruleset:${label}`, row['enforcement'] === 'disabled' ? 'ok' : types.includes('creation') ? 'human step' : 'gate (keep)', `${label}: ${String(row['enforcement'] ?? 'unknown')}; ${types.join(', ') || 'rules unavailable'}`);
      if (row['enforcement'] === 'active' && types.includes('pull_request')) {
        const pr = arr(row['rules']).find((x) => obj(x)['type'] === 'pull_request');
        if (Number(obj(obj(pr)['parameters'])['required_approving_review_count']) > 0) add(`reviews:${label}`, 'human step', `${label} requires approvals`);
      }
    }
    const tagCreation = activeRules.filter((r) => obj(r)['target'] === 'tag').some((r) => arr(obj(r)['rules']).some((rule) => obj(rule)['type'] === 'creation'));
    add('tag-creation', !ruleComplete ? 'unknown' : tagCreation ? 'human step' : 'ok', !ruleComplete ? 'Ruleset details unavailable' : tagCreation ? 'Active tag creation rule' : 'No active tag creation rule');
    if (envList) for (const env of envList) {
      const e = obj(env); const label = str(e['name']) ?? 'Unnamed environment';
      for (const rule of arr(e['protection_rules'])) { const p = obj(rule); if ((p['type'] === 'required_reviewers' && arr(p['reviewers']).length) || (p['type'] === 'wait_timer' && Number(p['wait_timer']) > 0)) add(`environment:${label}:${String(p['type'])}`, 'human step', `${label}: ${String(p['type'])}`); }
    } else add('environments', 'unknown', 'Environments unavailable');
    const workflows: { name: string; path: string; triggers: string[] | null; conclusion: string | null }[] = [];
    if (workflowList) for (const w of workflowList) {
      const row = obj(w); const path = str(row['path']); if (!path || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(path)) continue;
      const [content, runs] = await Promise.all([safe(() => read(`${base}/contents/${path}`)), path === '.github/workflows/auto-tag.yml' ? safe(() => read(`${base}/actions/workflows/auto-tag.yml/runs?per_page=1`)) : Promise.resolve(null)]);
      const events = triggers(content); const conclusion = str(obj(arr(obj(runs)['workflow_runs'])[0])['conclusion']);
      workflows.push({ name: str(row['name']) ?? path, path, triggers: events, conclusion });
      if (events === null) add(`workflow:${path}`, 'unknown', 'Workflow triggers unavailable');
      else if (events.length === 1 && events[0] === 'workflow_dispatch') add(`workflow:${path}`, 'human step', 'Only runs on workflow_dispatch');
      if (path === '.github/workflows/auto-tag.yml' && (runs === null || !Array.isArray(obj(runs)['workflow_runs']))) add('auto-tag-runs', 'unknown', 'Latest workflow run unavailable');
    }
    else add('workflows', 'unknown', 'Workflows unavailable');
    const auto = workflows.find((w) => w.path === '.github/workflows/auto-tag.yml');
    let exists: boolean | null = null;
    try { const file = obj(await read(`${base}/contents/.github/workflows/auto-tag.yml`)); if (file['type'] === 'file' || (file['encoding'] === 'base64' && typeof file['content'] === 'string')) exists = true; }
    catch (error) { if (error instanceof GitHubNotFoundError) exists = false; }
    const autoTag = { exists, conclusion: auto?.conclusion ?? null };
    if (exists && !auto) add('auto-tag-runs', 'unknown', 'Workflow is not registered or its runs are unavailable');
    add('auto-tag', autoTag.exists === null ? 'unknown' : autoTag.exists ? 'ok' : 'human step', autoTag.exists === null ? 'Workflow list unavailable' : autoTag.exists ? `Latest conclusion: ${autoTag.conclusion ?? 'unknown'}` : 'No auto-tag workflow');
    gates.push(gate(`${repo}:checks`, base, 'required status checks and merge queue', 'automate', 'Run machine checks and merge queue automatically; retain both gates.'), gate(`${repo}:reviews`, base, 'required approving reviews', 'cut', 'Remove human approvals and rely on automated checks.'), gate(`${repo}:tags`, base, 'tag rulesets', 'cut', 'Remove tag rulesets that block automated creation.'), gate(`${repo}:auto-tag`, base, 'auto-tag workflow', 'automate', 'Automatically tag verified releases and monitor workflow runs.'));
    repos.push({ repo: `ashlrai/${repo}`, defaultBranch: branch, allowAutoMerge: allow, mergeQueue: queue, rulesets: rules, environments: envList, workflows, autoTag, publishHold: switchState.on, items });
    if (items.some((item) => item.status === 'unknown')) complete = false;
  }
  return { repos, gates, complete };
}
export function formatAutonomy(report: AutonomyReport, markdown = false): string {
  const lines = markdown ? ['| Repository | Item | Status | Detail |', '| --- | --- | --- | --- |'] : [];
  for (const repo of report.repos) for (const item of repo.items) {
    const cells = [repo.repo, item.id, item.status, item.detail].map((s) => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' '));
    lines.push(markdown ? `| ${cells.join(' | ')} |` : `${cells[0]}: ${cells[1]}: ${cells[2]}: ${cells[3]}`);
  }
  if (markdown) lines.push('', '| Gate | Where | Kind | Classification | Reason |', '| --- | --- | --- | --- | --- |');
  for (const g of report.gates) { const cells = [g.id, g.where, g.kind, g.classification, g.reason].map((s) => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')); lines.push(markdown ? `| ${cells.join(' | ')} |` : `gate: ${cells.join(' | ')}`); }
  return lines.join('\n');
}
