import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetCiPlan } from '../src/cli/fleet-ci-plan.js';

const fixtures = [
  { file: 'ci.yml', text: `name: CI\non:\n  pull_request:\n    branches: ['**']\n    types: [opened, synchronize, reopened]\n  merge_group:\n  workflow_call:\n  schedule:\n    - cron: "3 9 * * *"\n  # Preserve dispatch inputs\n  workflow_dispatch:\n    inputs:\n      mac_shard:\n        type: string\n        default: all\njobs: {}\n` },
  { file: 'dependency-audit.yml', text: `on:\n  push:\n    paths: [package.json]\n  pull_request:\n  schedule:\n    - cron: "17 9 * * 1"\n` },
  { file: 'pr-topology.yml', text: 'on:\n  pull_request_target:\n  workflow_dispatch:\n' },
  { file: 'companion-smoke.yml', text: 'on:\n  schedule:\n    - cron: "20 9 * * *"\n' },
  { file: 'tags.yaml', text: 'on:\n  push:\n    tags: ["v*"]\n' },
  { file: 'malformed.yml', text: 'on: [broken\n' },
].map(item => ({ ...item, file: `.github/workflows/${item.file}` }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('fleet ci-plan CLI Nov 1', () => {
  function setup(withFolder = true): string {
    const root = mkdtempSync(join(tmpdir(), 'ci-plan-cli-')); roots.push(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    if (withFolder) {
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      for (const item of fixtures) writeFileSync(join(root, item.file), item.text);
    }
    return root;
  }
  it('prints only an applicable diff in patch mode', async () => {
    setup();
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdFleetCiPlan(['--patch']);
    expect(output.startsWith('diff --git')).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });
  it('prints a table and follow-ups, or complete JSON', async () => {
    setup(); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdFleetCiPlan([]);
    expect(log.mock.calls.flat().join('\n')).toContain('ashlr/verify');
    expect(log.mock.calls[0]![0]).toContain('file\taction');
    log.mockClear(); await cmdFleetCiPlan(['--json', '--cron', '30 9 * * *']);
    expect(JSON.parse(String(log.mock.calls[0]![0])).plans.find((plan: { added: string[] }) => plan.added.includes('schedule')).cron).toBe('30 9 * * *');
  });
  it('rejects invalid arguments without reading workflows', async () => {
    setup(false); vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [['--unknown'], ['--cron'], ['--json', '--patch']]) {
      await cmdFleetCiPlan(args); expect(process.exitCode).toBe(2);
    }
  });
  it('exits 2 for a missing workflow directory', async () => {
    setup(false); vi.spyOn(console, 'error').mockImplementation(() => {});
    await cmdFleetCiPlan(['--patch']); expect(process.exitCode).toBe(2);
  });
});
