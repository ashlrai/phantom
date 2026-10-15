/**
 * Task brief for dispatched coding agents: the repo's constitution (always-ask
 * list) plus the team context pack compiled for this task, appended to the
 * goal text the conductors hand to a sandboxed engine.
 *
 * Dispatched agents get only the goal text; nothing makes them open
 * CONSTITUTION.md or the team context store, so the rules they must follow and
 * the evidence the team already recorded have to travel in the prompt. Additive text only: no
 * authority, tool or sandbox change. Opt out with `foundry.taskContext: false`.
 * Never throws; any failure yields '' and the goal goes out unchanged.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AshlrConfig } from '../types.js';
import type { OwnerScope } from './protocol.js';
import { compileTaskContext, retrieveContext, type ContextScope } from './context.js';

const MAX_CONSTITUTION_BYTES = 64 * 1024;
const DEFAULT_BUDGET_TOKENS = 1500;

export interface TaskBriefOptions {
  repo?: string;
  title: string;
  detail?: string;
  cfg?: AshlrConfig;
  team?: string;
  owner?: OwnerScope;
  budgetTokens?: number;
}

export function taskContextEnabled(cfg: AshlrConfig | undefined): boolean {
  return (cfg?.foundry as Record<string, unknown> | undefined)?.['taskContext'] !== false;
}

function readConstitution(repo: string | undefined): string | null {
  if (!repo) return null;
  const path = join(repo, 'CONSTITUTION.md');
  try {
    if (!existsSync(path) || statSync(path).size > MAX_CONSTITUTION_BYTES) return null;
    const text = readFileSync(path, 'utf8');
    return /^version:\s*\d+/m.test(text) && /## Always ask/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** `owner/name` from the origin remote, else the directory name. Team context is keyed by project. */
export function repoProjectSlug(repo: string): string {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    }).trim();
    const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1]!;
  } catch { /* No git or no origin: fall back to the folder name. */ }
  return basename(repo);
}

/**
 * Brief text starting with a separator, or '' when there is nothing to add.
 * Callers APPEND it: proposal titles and localization use the goal's first
 * characters, so the goal itself must stay first.
 */
export function buildTaskBrief(opts: TaskBriefOptions): string {
  try {
    if (!taskContextEnabled(opts.cfg)) return '';
    const team = opts.team ?? 'default';
    const scope: ContextScope = { owner: opts.owner ?? 'company', ...(opts.repo ? { project: repoProjectSlug(opts.repo) } : {}) };
    const budgetTokens = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
    const constitution = readConstitution(opts.repo);
    if (constitution) {
      const compiled = compileTaskContext(team, { title: opts.title, detail: opts.detail, scope, budgetTokens }, constitution);
      return `\n\n---\n## Task context (compiled by Phantom)\n\n${compiled.text}\n`;
    }
    const pack = retrieveContext(team, { query: `${opts.title} ${opts.detail ?? ''}`, scope, budgetTokens });
    if (pack.items.length === 0) return '';
    const body = pack.items.map(i => `- ${i.title} [${i.source}, ${i.ts.slice(0, 10)}]: ${i.excerpt}`).join('\n');
    return `\n\n---\n## Task context (compiled by Phantom)\n\nEvidence:\n${body}\n`;
  } catch {
    return '';
  }
}
