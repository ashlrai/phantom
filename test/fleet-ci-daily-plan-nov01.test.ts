import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { planCiDaily, planWorkflow, unifiedDiff } from '../src/core/fleet/ci-daily-plan.js';

// Inline fixtures modelled on the real workflow files on master (Nov 1 2026).
const CI = `name: CI

on:
  # PRs and the merge queue run only the seconds-fast gate (Mason, Oct 28 2026:
  # merge fast, test later, fix forward daily). Full suites run once a day on
  # master, on manual dispatch, and on reusable workflow_call.
  pull_request:
    branches: ["**"]
    types: [opened, synchronize, reopened]
  merge_group:
  workflow_call:
  # Daily full suite on master at 05:03 ET (09:03 UTC). Staggered from the other
  # six repos' daily runs so its seven macOS jobs never share the org's macOS
  # concurrency with them (RQ-DAILY-15).
  schedule:
    - cron: "3 9 * * *"
  # Mac/win waiver (Mason, Oct 26 2026): macOS lanes never run on PR or merge_group.
  workflow_dispatch:
    inputs:
      mac_shard:
        description: Mac exhaustive slice (all = complete set, 0-6 = one daily slice)
        type: choice
        default: all
        options: [all, '0', '1', '2', '3', '4', '5', '6']

permissions:
  contents: read

jobs:
  merge-gate:
    name: Merge Gate
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
`;

const DEPENDENCY_AUDIT = `name: Dependency Audit

on:
  push:
    branches: [master]
    paths:
      - "package.json"
      - "package-lock.json"
      - ".npmrc"
  pull_request:
    branches: ["**"]
  schedule:
    - cron: "17 9 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  audit:
    name: Dependency audit
    runs-on: ubuntu-latest
    steps:
      - run: npm audit
`;

const PR_TOPOLOGY = `name: PR topology observation (non-authoritative)

# Shadow telemetry only. Do not add this context to required status checks.

on:
  pull_request_target:
    branches: ["**"]
    types: [opened, reopened, synchronize, edited, closed]
  workflow_dispatch:
    inputs:
      pull_request_number:
        description: Open pull request number to inspect
        required: true
        type: number

permissions:
  contents: read
  pull-requests: read

jobs:
  topology:
    runs-on: ubuntu-latest
    steps:
      - run: echo topology
`;

const COMPANION_SMOKE = `name: Companion Smoke

# Runs scripts/companion-workflow-smoke.mjs --published against what users
# install from npm and GitHub releases.

on:
  schedule:
    - cron: "0 10 * * *"
  workflow_dispatch:

jobs:
  published:
    runs-on: ubuntu-latest
    steps:
      - run: echo smoke
`;

const TAG_PUSH = `name: Release

on:
  push:
    tags: ["v3.3.2"]

permissions: {}

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: echo release
`;

const MALFORMED = `name: broken

on:
  pull_request: [
    branches: ["**"]

jobs:
  x: {
`;

const FILES = [
  { file: '.github/workflows/ci.yml', text: CI },
  { file: '.github/workflows/dependency-audit.yml', text: DEPENDENCY_AUDIT },
  { file: '.github/workflows/pr-topology.yml', text: PR_TOPOLOGY },
  { file: '.github/workflows/companion-smoke.yml', text: COMPANION_SMOKE },
  { file: '.github/workflows/release.yml', text: TAG_PUSH },
  { file: '.github/workflows/broken.yml', text: MALFORMED },
];

const byFile = (files: typeof FILES) => {
  const { plans, patch, summary, followUps } = planCiDaily(files);
  const map = new Map(plans.map((p) => [p.file.split('/').pop()!, p]));
  return { plans, patch, summary, followUps, map };
};

describe('planCiDaily trigger planning', () => {
  const { plans, patch, summary, followUps, map } = byFile(FILES);

  it('removes pull_request from ci.yml and keeps the daily/manual triggers', () => {
    const p = map.get('ci.yml')!;
    expect(p.action).toBe('change');
    expect(p.name).toBe('CI');
    expect(p.removed).toEqual(['pull_request']);
    expect(p.kept).toEqual(['merge_group', 'workflow_call', 'schedule', 'workflow_dispatch']);
    expect(p.added).toEqual([]);
    expect(p.cron).toBe('3 9 * * *'); // existing nightly slot survives
    expect(p.after).not.toContain('pull_request');
  });

  it('removes push+pull_request from dependency-audit.yml, keeps weekly schedule', () => {
    const p = map.get('dependency-audit.yml')!;
    expect(p.action).toBe('change');
    expect(p.removed).toEqual(['push', 'pull_request']);
    expect(p.kept).toEqual(['schedule', 'workflow_dispatch']);
    expect(p.added).toEqual([]);
    expect(p.cron).toBe('17 9 * * 1');
  });

  it('removes pull_request_target from pr-topology.yml and adds a nightly schedule', () => {
    const p = map.get('pr-topology.yml')!;
    expect(p.action).toBe('change');
    expect(p.removed).toEqual(['pull_request_target']);
    expect(p.kept).toEqual(['workflow_dispatch']);
    expect(p.added).toEqual(['schedule']);
    expect(p.cron).toBe('3 9 * * *'); // only file needing a slot -> first window minute
    expect(p.after).toContain('schedule:');
    expect(p.after).toContain('cron: "3 9 * * *"');
    expect(p.after).toContain('pull_request_number:'); // dispatch inputs survive
    expect(p.after).not.toContain('pull_request_target');
  });

  it('keeps a schedule-only workflow', () => {
    const p = map.get('companion-smoke.yml')!;
    expect(p.action).toBe('keep');
    expect(p.cron).toBe('0 10 * * *');
    expect(p.after).toBe(COMPANION_SMOKE);
  });

  it('keeps a tags-only push trigger and says so in reason', () => {
    const p = map.get('release.yml')!;
    expect(p.action).toBe('keep');
    expect(p.kept).toEqual(['push']);
    expect(p.reason).toContain('tags-only');
  });

  it('skips a file that does not parse, with the parse error in reason', () => {
    const p = map.get('broken.yml')!;
    expect(p.action).toBe('skip');
    expect(p.reason).toContain('does not parse');
    expect(p.after).toBe(MALFORMED);
  });

  it('preserves comments and workflow_dispatch inputs in rewritten ci.yml', () => {
    const after = map.get('ci.yml')!.after;
    expect(after).toContain('# Daily full suite on master at 05:03 ET (09:03 UTC).');
    expect(after).toContain('# Mac/win waiver (Mason, Oct 26 2026)');
    expect(after).toContain('mac_shard:');
    expect(after).toContain('options: [all, \'0\', \'1\', \'2\', \'3\', \'4\', \'5\', \'6\']');
    expect(after).toContain('merge_group:');
    expect(after).toContain('workflow_call:');
  });

  it('produces a patch that git apply --check accepts and that is idempotent', () => {
    expect(patch).toMatch(/^diff --git a\/.github\/workflows\/ci\.yml b\/.github\/workflows\/ci\.yml/);
    const dir = mkdtempSync(join(tmpdir(), 'ci-daily-plan-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      for (const f of FILES.filter((f) => map.get(f.file.split('/').pop()!)!.action === 'change')) {
        const dest = join(dir, f.file);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, f.text);
      }
      execFileSync('git', ['apply', '--check'], { cwd: dir, input: patch });
      execFileSync('git', ['apply'], { cwd: dir, input: patch });
      // Second run on the patched tree: everything is 'keep'.
      const second = planCiDaily(FILES.map((f) => ({
        file: f.file,
        text: map.get(f.file.split('/').pop()!)!.action === 'change' ? readFileSync(join(dir, f.file), 'utf8') : f.text,
      })));
      expect(second.plans.every((p) => p.action !== 'change')).toBe(true);
      expect(second.plans.filter((p) => p.action === 'keep').map((p) => p.file))
        .toEqual(expect.arrayContaining(['.github/workflows/ci.yml', '.github/workflows/dependency-audit.yml', '.github/workflows/pr-topology.yml']));
      expect(second.patch).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports summary and the required-check follow-ups', () => {
    expect(summary).toContain('3 change');
    expect(summary).toContain('2 keep');
    expect(summary).toContain('1 skip');
    const text = followUps.join('\n');
    expect(text).toContain('Merge Gate');
    expect(text).toContain('ashlr/verify');
    expect(text).toContain('gh api');
    expect(text).toContain('required_status_checks');
    expect(plans.map((p) => p.file)).toEqual([...plans.map((p) => p.file)].sort());
  });
});

describe('planWorkflow options', () => {
  it('honours an explicit cron for an added schedule', () => {
    const p = planWorkflow('w.yml', PR_TOPOLOGY, { cron: '42 5 * * *', keepMergeGroup: true });
    expect(p.cron).toBe('42 5 * * *');
    expect(p.after).toContain('cron: "42 5 * * *"');
  });

  it('removes merge_group when keepMergeGroup is false', () => {
    const p = planWorkflow('w.yml', CI, { cron: '3 9 * * *', keepMergeGroup: false });
    expect(p.removed).toEqual(['pull_request', 'merge_group']);
    expect(p.kept).toEqual(['workflow_call', 'schedule', 'workflow_dispatch']);
  });

  it('removes only the trigger keys — comments stay attached to survivors', () => {
    const p = planWorkflow('w.yml', CI, { cron: '3 9 * * *', keepMergeGroup: true });
    expect(p.after).toContain('seconds-fast gate'); // comment survives, reattached to the next pair
    expect(p.after).toContain('# Mac/win waiver');
    expect(p.after).not.toMatch(/^\s+pull_request:/m);
    expect(p.before).toMatch(/^\s+pull_request:/m);
  });

  it('unifiedDiff returns empty for identical text', () => {
    expect(unifiedDiff('x', 'a\nb\n', 'a\nb\n')).toBe('');
  });
});

describe('staggered default crons', () => {
  it('spreads needy files across 09:03-09:30 UTC deterministically by file name', () => {
    const needy = (name: string) => ({
      file: `.github/workflows/${name}`,
      text: `name: ${name}\non:\n  pull_request:\n  workflow_dispatch:\n\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n`,
    });
    const { plans } = planCiDaily([needy('c.yml'), needy('a.yml'), needy('b.yml')]);
    expect(plans.map((p) => p.cron)).toEqual(['3 9 * * *', '17 9 * * *', '30 9 * * *']);
    expect(plans.map((p) => p.file)).toEqual([
      '.github/workflows/a.yml', '.github/workflows/b.yml', '.github/workflows/c.yml',
    ]);
  });

  it('--cron override applies to every added schedule', () => {
    const needy = (name: string) => ({
      file: `.github/workflows/${name}`,
      text: `on: pull_request\n`,
    });
    const { plans } = planCiDaily([needy('a.yml'), needy('b.yml')], { cron: '0 4 * * *' });
    expect(plans.every((p) => p.cron === '0 4 * * *')).toBe(true);
    expect(plans.every((p) => p.added.includes('schedule'))).toBe(true);
    expect(plans.every((p) => p.after.includes('cron: "0 4 * * *"'))).toBe(true);
  });
});
