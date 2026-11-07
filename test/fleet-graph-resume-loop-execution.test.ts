import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fault = vi.hoisted(() => ({ checkpointWritesToFail: 0 }));
vi.mock('../src/core/util/private-file-write.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/core/util/private-file-write.js')>();
  return {
    ...original,
    writePrivateFileAtomically: (...args: Parameters<typeof original.writePrivateFileAtomically>) => {
      if (args[3].label === 'checkpoint' && fault.checkpointWritesToFail > 0) {
        fault.checkpointWritesToFail--;
        throw Error('injected checkpoint write failure');
      }
      return original.writePrivateFileAtomically(...args);
    },
  };
});
import { graphResumeRun } from '../src/core/fleet/graph-resume-run.js';

let dir = '', previousRuns: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-resume-ambiguity-'));
  previousRuns = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  if (previousRuns === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previousRuns;
  rmSync(dir, { recursive: true, force: true });
});

it('shows that a checkpoint write failure can be indistinguishable from an ordinary child failure', async () => {
  const file = join(dir, 'graph.json');
  const ordinaryCheckpoint = join(dir, 'ordinary.json');
  const faultCheckpoint = join(dir, 'fault.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ id: 'A', argv: [process.execPath, '-e', 'process.exit(7)'] }] }));
  const ordinary = await graphResumeRun(file, ordinaryCheckpoint, true, 10000, 1);
  fault.checkpointWritesToFail = 1;
  const persistenceFailure = await graphResumeRun(file, faultCheckpoint, true, 10000, 1);
  expect(fault.checkpointWritesToFail).toBe(0);
  expect(ordinary).toEqual({ status: 'failed', nodes: [{ id: 'A', status: 'failed', exitCode: 7 }], retained: [], retried: ['A'] });
  expect(persistenceFailure).toEqual(ordinary);
  expect(readFileSync(faultCheckpoint, 'utf8')).toBe(readFileSync(ordinaryCheckpoint, 'utf8'));
});
