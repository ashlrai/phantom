/**
 * `phm run "<goal>" --json` promises JSON on stdout. On a fresh machine with
 * no local model the local-first refusal used to write only human text to
 * stderr, leaving an agent with empty stdout to parse. Refusals and errors
 * now emit a JSON object on stdout and keep their exit codes (3 and 1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let runGoalImpl: () => Promise<unknown> = async () => { throw new Error('unset'); };

vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: () => runGoalImpl(),
  loadRun: () => null,
  listRuns: () => [],
}));

vi.mock('../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/config.js')>();
  return { ...actual, loadConfig: () => actual.defaultConfig() };
});

import { cmdRun } from '../src/cli/run.js';

let stdout: string;
let stderr: string;

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('phm run --json failure output', () => {
  it('prints a JSON refusal on stdout and exits 3 when no local provider is reachable', async () => {
    runGoalImpl = async () => {
      throw new Error('local-first: no provider is reachable (pass --allow-cloud to use a cloud provider)');
    };
    const code = await cmdRun(['Explain this module', '--json', '--no-stream']);
    expect(code).toBe(3);
    const parsed = JSON.parse(stdout) as { ok: boolean; status: string; reason: string; fix: string[] };
    expect(parsed).toMatchObject({ ok: false, status: 'refused', reason: 'local-first' });
    expect(parsed.fix.join('\n')).toMatch(/--allow-cloud/);
    expect(stderr).toMatch(/Local-first refusal/);
  });

  it('prints a JSON error on stdout and exits 1 for other run failures', async () => {
    runGoalImpl = async () => { throw new Error('planner crashed'); };
    const code = await cmdRun(['Explain this module', '--json', '--no-stream']);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ ok: false, status: 'error', error: 'planner crashed' });
  });

  it('keeps the human refusal on stdout without --json', async () => {
    runGoalImpl = async () => { throw new Error('local-first: no provider is reachable'); };
    const code = await cmdRun(['Explain this module', '--no-stream']);
    expect(code).toBe(3);
    expect(stdout).toMatch(/Local-first refusal/);
    expect(() => JSON.parse(stdout)).toThrow();
  });
});
