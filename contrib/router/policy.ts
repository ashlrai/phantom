import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { globMatches, matchProtectedPath, detectTestTampering, normalizeRepoPath } from '../../src/core/authority/protected-paths.js';

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const SHA = /^[a-f0-9]{40}$/;
export const ID = /^(?!(?:constructor|prototype|toString|valueOf|hasOwnProperty|isPrototypeOf|propertyIsEnumerable|toLocaleString)$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const REASONS = ['quality', 'security', 'tests', 'scope', 'uncertain'] as const;
export function localEndpoint(value: unknown): boolean {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/api\/chat$/.test(value)) return false;
  const port = Number(value.split(':')[2].split('/')[0]);
  return port > 0 && port <= 65535;
}
export interface Verdict { verdict: 'approve' | 'reject'; reasons: typeof REASONS[number][] }
export interface Job { id: string; repo: string; pool: string; prompt: string }
export interface Pool { executable: string; args: string[] }
export interface Config {
  repos: string[]; pools: Record<string, Pool>; gh: string; supervisorHome: string;
  reviewer: { endpoint: string; model: string }; dailyCap: number; denylist: string[];
  requiredChecks: Record<string, string[]>; maxDiffBytes: number; jobUser: string; box: Pool;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-object');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join() !== expected.sort().join()) throw new Error('invalid-fields');
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && v.length > 0 && v.length < 4096)) throw new Error('invalid-strings');
  return value;
}
export function configFrom(value: unknown): Config {
  const c = object(value);
  keys(c, ['repos', 'pools', 'gh', 'supervisorHome', 'reviewer', 'dailyCap', 'denylist', 'requiredChecks', 'maxDiffBytes', 'jobUser', 'box']);
  if (typeof c.jobUser !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(c.jobUser) || c.jobUser === 'root') throw new Error('separate-job-user-required');
  const repos = strings(c.repos);
  if (repos.length !== 7 || new Set(repos).size !== 7 || repos.some(r => !/^ashlrai\/[a-z0-9][a-z0-9-]*$/.test(r))) throw new Error('seven-repos-required');
  for (const name of ['gh', 'supervisorHome'] as const) if (typeof c[name] !== 'string' || !isAbsolute(c[name])) throw new Error('absolute-path-required');
  const pools = object(c.pools);
  if (!Object.keys(pools).length) throw new Error('pools-required');
  const entries: [string, unknown][] = [...Object.entries(pools), ['box', c.box]];
  for (const [name, raw] of entries) {
    const p = object(raw); keys(p, ['executable', 'args']);
    if (!ID.test(name) || typeof p.executable !== 'string' || !isAbsolute(p.executable)) throw new Error('invalid-pool');
    if (!Array.isArray(p.args) || !p.args.every(a => typeof a === 'string' && !a.includes('\0'))) throw new Error('invalid-args');
  }
  const reviewer = object(c.reviewer); keys(reviewer, ['endpoint', 'model']);
  // A local inference server has no inherited CLI session, credential, tools or conversation.
  if (!localEndpoint(reviewer.endpoint) || typeof reviewer.model !== 'string' || !/^[\w:./-]{1,128}$/.test(reviewer.model)) throw new Error('invalid-reviewer');
  if (!Number.isInteger(c.dailyCap) || Number(c.dailyCap) < 1 || Number(c.dailyCap) > 10) throw new Error('invalid-daily-cap');
  if (!Number.isInteger(c.maxDiffBytes) || Number(c.maxDiffBytes) < 1 || Number(c.maxDiffBytes) > 262144) throw new Error('invalid-diff-cap');
  strings(c.denylist);
  const checks = object(c.requiredChecks);
  if (Object.keys(checks).sort().join() !== [...repos].sort().join()) throw new Error('checks-required');
  for (const r of repos) if (!strings(checks[r]).length) throw new Error('checks-required');
  return c as unknown as Config;
}
export function queueFrom(markdown: string, config: Config): Job[] {
  if (markdown.length > 262144) throw new Error('queue-too-large');
  const blocks = [...markdown.matchAll(/^```router-jobs\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1) throw new Error('one-queue-block-required');
  const jobs: unknown = JSON.parse(blocks[0][1]);
  if (!Array.isArray(jobs) || jobs.length > 100) throw new Error('invalid-queue');
  const ids = new Set<string>();
  for (const raw of jobs) {
    const j = object(raw); keys(j, ['id', 'repo', 'pool', 'prompt']);
    if (typeof j.id !== 'string' || !ID.test(j.id) || ids.has(j.id)) throw new Error('invalid-job-id');
    ids.add(j.id);
    if (!config.repos.includes(String(j.repo)) || !Object.hasOwn(config.pools, String(j.pool))) throw new Error('invalid-job-target');
    if (typeof j.prompt !== 'string' || j.prompt.length < 1 || j.prompt.length > 32768) throw new Error('invalid-prompt');
  }
  return jobs as Job[];
}
export function verdictFrom(raw: string): Verdict {
  if (raw.length > 2048) throw new Error('invalid-verdict');
  const v = object(JSON.parse(raw)); keys(v, ['verdict', 'reasons']);
  if (!['approve', 'reject'].includes(String(v.verdict)) || !Array.isArray(v.reasons) ||
      v.reasons.some(r => !REASONS.includes(r)) || v.reasons.length > 5 ||
      (v.verdict === 'approve' ? v.reasons.length !== 0 : v.reasons.length === 0)) throw new Error('invalid-verdict');
  return v as unknown as Verdict;
}
export interface FileChange { filename: string; previous_filename?: string; patch?: string; additions: number; deletions: number; status: string }
// CODEOWNERS is deny-only here: no later rule can unprotect an earlier one.
export function owned(path: string, codeowners: string): boolean {
  return codeowners.split('\n').some(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return false;
    const [pattern, ...owners] = trimmed.split(/\s+/);
    if (!owners.length || ['!', '[', ']', '\\'].some(c => pattern.includes(c))) throw new Error('unsupported-codeowners');
    const p = pattern.replace(/^\//, '').replace(/\/$/, '/**');
    return globMatches(p, path) || (!pattern.startsWith('/') && globMatches(`**/${p}`, path)) ||
      globMatches(`${p}/**`, path) || (!pattern.startsWith('/') && globMatches(`**/${p}/**`, path));
  });
}
export function screen(repo: string, files: FileChange[], diff: string, codeowners: string, config: Config): void {
  if (!files.length || files.length > 300 || !diff || diff.length > config.maxDiffBytes) throw new Error('diff-bounds');
  for (const file of files) {
    for (const path of [file.filename, file.previous_filename].filter((p): p is string => p !== undefined)) {
      if (!normalizeRepoPath(path) || path !== normalizeRepoPath(path) || /[\s"\\]/.test(path) ||
          matchProtectedPath(path, { selfRepo: repo === 'ashlrai/phantom' }) ||
          /(^|\/)(scripts|\.github|contrib\/router)(\/|$)|(^|\/)(build\.rs|vercel\.(json|ts))$/i.test(path) ||
          config.denylist.some(p => globMatches(p, path)) || owned(path, codeowners)) throw new Error('denied-path');
    }
    if (!file.patch || /^(?:new|old) mode 120000|^new file mode 120000|^GIT binary patch|^Binary files/m.test(diff)) throw new Error('incomplete-diff');
    const lines = file.patch.split('\n');
    if (lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length !== file.additions ||
        lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length !== file.deletions) throw new Error('incomplete-diff');
    // Scan the whole patch, including context: obfuscated/ambiguous cases go to the box.
    if (/https?:|\b(fetch|curl|wget|axios|requests|https?|net|socket|exec|spawn|eval|Function|require|import)\b|process\s*(?:\.|\[)|\b(env|environ|getenv|credential|token|secret|password)\b/i.test(file.patch)) throw new Error('security-finding');
  }
  const tamper = detectTestTampering(diff);
  if (tamper.parseError || tamper.findings.length) throw new Error('test-tampering');
}
export interface Check { name: string; state: string }
export function green(checks: Check[], required: string[]): boolean {
  return checks.length > 0 && checks.every(c => c.state === 'success') && required.every(name => checks.some(c => c.name === name));
}
