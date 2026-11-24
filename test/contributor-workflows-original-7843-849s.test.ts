import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
type Events = { push: { branches: string[]; paths: string[] }; pull_request: { paths: string[]; types: string[] }; schedule: unknown[] };
type Workflow = { on: Events; jobs: Record<string, { name: string }> };
const workflow = (path: string) => parse(read(path)) as Workflow;
const contributing = read('CONTRIBUTING.md');
const guide = read('docs/CONTRIBUTE-WITH-AN-AGENT.md');

describe('contributor workflow documentation contracts', () => {
  it('describes conditional dependency audits for PRs and default-branch pushes', () => {
    const events = workflow('.github/workflows/dependency-audit.yml').on;
    expect(events.push.branches).toContain('master');
    expect(events.pull_request.paths).toEqual(events.push.paths);
    expect(events.pull_request.paths).toEqual(expect.arrayContaining([
      'package.json', 'package-lock.json', '.npmrc', 'src/raycast/package.json',
      'desktop/src-tauri/Cargo.toml', 'desktop/src-tauri/Cargo.lock',
      'scripts/npm-audit-with-osv-fallback.sh', '.github/dependency-audit-exceptions.json',
      'docs/DEPENDENCY-SECURITY.md', '.github/dependabot.yml', '.github/workflows/dependency-audit.yml',
    ]));
    expect(events.schedule).toHaveLength(1);
    expect(contributing).toMatch(/Dependency Audit workflow runs on\s+them only when a manifest, lockfile or other dependency input changes, plus a\s+daily schedule/);
    expect(guide).toMatch(/Dependency audit \(root \+ Raycast\).*runs only when a manifest, lockfile or\s+audit configuration changes/);
    expect(guide).toMatch(/other audit inputs need not be/);
  });

  it('documents advisory perf timing and configurable tolerance', () => {
    const perf = workflow('.github/workflows/perf-budget.yml');
    expect(perf.on.pull_request.types).toEqual(['opened', 'reopened', 'ready_for_review']);
    expect(perf.on.schedule).toHaveLength(1);
    expect(perf.on).not.toHaveProperty('merge_group');
    expect(perf.jobs['perf-budget'].name).toMatch(/advisory, non-required/);
    const budgets = JSON.parse(read('perf/budgets.json')) as { tolerance: number };
    expect(budgets.tolerance * 100).toBe(20);
    const script = read('scripts/perf-budget.mjs');
    expect(script).toMatch(/numberField\(t\.tolerance,[^\n]+\?\? tolerance/);
    expect(script).toContain('target.baselineMs * (1 + target.tolerance)');
    expect(guide).toMatch(/opened,\s+reopened or marked ready, not on later pushes/);
    expect(guide).toMatch(/20% unless a target sets its own/);
    expect(guide).toMatch(/not required and\s+do not block auto-merge/);
  });
});
