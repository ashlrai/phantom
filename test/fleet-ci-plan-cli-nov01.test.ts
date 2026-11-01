import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdFleetCiPlan } from '../src/cli/fleet-ci-plan.js';

const CI = `name: CI

on:
  pull_request:
    branches: ["**"]
  merge_group:
  schedule:
    - cron: "3 9 * * *"
  workflow_dispatch:

jobs:
  quick:
    runs-on: ubuntu-latest
    steps:
      - run: echo quick
`;

const SMOKE = `name: Companion Smoke

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

let output: string[];
let errors: string[];
let dir: string;

beforeEach(() => {
  output = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(process.stdout, 'write').mockImplementation((value: string | Uint8Array) => { output.push(String(value)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((value: string | Uint8Array) => { errors.push(String(value)); return true; });
  dir = mkdtempSync(join(tmpdir(), 'fleet-ci-plan-'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe('ashlr fleet ci-plan', () => {
  it('prints the plan table and follow-ups for a seeded workflows folder', async () => {
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), CI);
    writeFileSync(join(dir, '.github', 'workflows', 'companion-smoke.yml'), SMOKE);
    expect(await cmdFleetCiPlan([], { cwd: dir })).toBe(0);
    const text = output.join('');
    expect(text).toContain('ci.yml');
    expect(text).toContain('change');
    expect(text).toContain('companion-smoke.yml');
    expect(text).toContain('keep');
    expect(text).toContain('Merge Gate');
    expect(text).toContain('ashlr/verify');
    expect(text).toContain('gh api');
  });

  it('--patch writes only the unified diff to stdout', async () => {
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), CI);
    expect(await cmdFleetCiPlan(['--patch'], { cwd: dir })).toBe(0);
    expect(output.join('')).toMatch(/^diff --git a\/.github\/workflows\/ci\.yml/);
    expect(output.join('')).not.toContain('Merge Gate'); // follow-ups stay off stdout
    expect(output.join('')).toContain('@@');
    expect(errors.join('')).toContain('git apply');
  });

  it('--json prints the planCiDaily result', async () => {
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), CI);
    expect(await cmdFleetCiPlan(['--json'], { cwd: dir })).toBe(0);
    const report = JSON.parse(output.join(''));
    expect(report.plans).toHaveLength(1);
    expect(report.plans[0].file).toBe('.github/workflows/ci.yml');
    expect(report.plans[0].action).toBe('change');
    expect(report.patch).toContain('diff --git');
    expect(report.followUps.length).toBeGreaterThan(0);
  });

  it('exits 2 when the workflows folder is missing', async () => {
    rmSync(join(dir, '.github'), { recursive: true, force: true });
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent'); // stop the upward walk at the fake worktree root
    expect(await cmdFleetCiPlan([], { cwd: dir })).toBe(2);
    expect(errors.join('')).toContain('No .github/workflows folder');
    expect(await cmdFleetCiPlan(['--patch'], { cwd: dir })).toBe(2);
  });

  it('exits 2 on an unknown argument or a bad cron', async () => {
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), CI);
    expect(await cmdFleetCiPlan(['--bogus'], { cwd: dir })).toBe(2);
    expect(await cmdFleetCiPlan(['--cron', 'not-a-cron'], { cwd: dir })).toBe(2);
    expect(await cmdFleetCiPlan(['--help'], { cwd: dir })).toBe(0);
  });
});
