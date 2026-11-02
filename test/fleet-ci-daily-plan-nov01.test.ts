import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planCiDaily, planWorkflow } from '../src/core/fleet/ci-daily-plan.js';

export const fixtures = [
  { file: 'ci.yml', text: `name: CI\non:\n  pull_request:\n    branches: ['**']\n    types: [opened, synchronize, reopened]\n  merge_group:\n  workflow_call:\n  schedule:\n    - cron: "3 9 * * *"\n  # Preserve dispatch inputs\n  workflow_dispatch:\n    inputs:\n      mac_shard:\n        type: string\n        default: all\njobs: {}\n` },
  { file: 'dependency-audit.yml', text: `on:\n  push:\n    paths: [package.json]\n  pull_request:\n  schedule:\n    - cron: "17 9 * * 1"\n` },
  { file: 'pr-topology.yml', text: 'on:\n  pull_request_target:\n  workflow_dispatch:\n' },
  { file: 'companion-smoke.yml', text: 'on:\n  schedule:\n    - cron: "20 9 * * *"\n' },
  { file: 'tags.yaml', text: 'on:\n  push:\n    tags: ["v*"]\n' },
  { file: 'malformed.yml', text: 'on: [broken\n' },
].map(item => ({ ...item, file: `.github/workflows/${item.file}` }));

describe('daily CI plan Nov 1', () => {
  it('preserves schedules, comments and dispatch inputs while removing PR/push events', () => {
    const { plans } = planCiDaily(fixtures);
    const ci = plans.find(plan => plan.name === 'CI')!;
    expect(ci.removed).toEqual(['pull_request']);
    expect(ci.kept).toEqual(['merge_group', 'workflow_call', 'schedule', 'workflow_dispatch']);
    expect(ci.added).toEqual([]);
    expect(ci.cron).toBe('3 9 * * *');
    expect(ci.after).toContain('# Preserve dispatch inputs');
    expect(ci.after).toContain('default: all');
    const audit = plans.find(plan => plan.file.endsWith('dependency-audit.yml'))!;
    expect(audit.removed).toEqual(['push', 'pull_request']);
    expect(audit.kept).toEqual(['schedule']);
    expect(audit.added).toEqual([]);
    expect(audit.cron).toBe('17 9 * * 1');
    const topology = plans.find(plan => plan.file.endsWith('pr-topology.yml'))!;
    expect(topology.removed).toEqual(['pull_request_target']);
    expect(topology.kept).toEqual(['workflow_dispatch']);
    expect(topology.added).toEqual(['schedule']);
    for (const name of ['companion-smoke.yml', 'tags.yaml']) {
      const plan = plans.find(plan => plan.file.endsWith(name))!;
      expect(plan.action).toBe('keep');
      expect(plan.after).toBe(plan.before);
      expect(plan.removed).toEqual([]);
      expect(plan.added).toEqual([]);
    }
    expect(plans.find(plan => plan.file.endsWith('tags.yaml'))!.reason).toContain('tags only');
    expect(plans.find(plan => plan.action === 'skip')!.reason).toMatch(/flow/i);
  });

  it('generates an applicable and idempotent patch without a final newline', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-plan-'));
    const valid = fixtures.filter(item => !item.file.endsWith('malformed.yml'));
    valid.push({ file: '.github/workflows/scalar.yml', text: 'on: push' });
    try {
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      for (const item of valid) writeFileSync(join(root, item.file), item.text);
      execFileSync('git', ['init', '-q', root]);
      const { patch } = planCiDaily(valid);
      execFileSync('git', ['apply', '--check', '-'], { cwd: root, input: patch });
      execFileSync('git', ['apply', '-'], { cwd: root, input: patch });
      expect(planCiDaily(valid.map(item => ({ file: item.file, text: readFileSync(join(root, item.file), 'utf8') }))).plans.every(plan => plan.action === 'keep')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('supports list events, merge-group removal, branch pushes and cron overrides deterministically', () => {
    expect(planWorkflow('x', 'on: [push, release, repository_dispatch, workflow_call, merge_group]\n', { cron: '8 9 * * *', keepMergeGroup: false }).removed).toEqual(['push', 'merge_group']);
    expect(planWorkflow('x', 'on:\n  push:\n    tags: [v*]\n    branches: [master]\n', { cron: '8 9 * * *', keepMergeGroup: true }).removed).toEqual(['push']);
    expect(planCiDaily([...fixtures].reverse())).toEqual(planCiDaily(fixtures));
    expect(planCiDaily(fixtures, { cron: '30 9 * * *' }).plans.find(plan => plan.added.length)!.cron).toBe('30 9 * * *');
  });
});
