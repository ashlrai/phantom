import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'cos-s-debug-')); });
afterEach(async () => { process.env.ASHLR_RUNS_DIR = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(runsDir, { recursive: true, force: true }).catch(() => {}); });

describe('debug status', () => {
  it('shows what status actually returns', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('HOME', runsDir);
    process.env.ASHLR_RUNS_DIR = runsDir;

    const mod = await import('../src/cli/cos.js');
    const exit1 = await mod.cmdCos('ask', 'Prepare a project brief', '--channel', 'cli', '--json');
    const response = JSON.parse(output.mock.calls.at(-1)![0] as string);
    console.error('=== ASK response:', JSON.stringify(response));
    console.error('=== ASK response.id:', response.id);
    
    // Check what queue file exists
    const queuePath = join(runsDir, 'queue', 'queue.v1.json');
    const queueContent = await readFile(queuePath, 'utf8');
    const queueDoc = JSON.parse(queueContent);
    console.error('=== Queue jobs:', JSON.stringify(queueDoc.jobs.map(j => ({ id: j.id, status: j.status }))));
    console.error('=== runsDir:', runsDir);
    console.error('=== ASHLR_RUNS_DIR:', process.env.ASHLR_RUNS_DIR);

    // Now try status
    const exit2 = await mod.cmdCos('status', response.id, '--json');
    const statusOutput = JSON.parse(output.mock.calls.at(-1)![0] as string);
    console.error('=== STATUS result:', JSON.stringify(statusOutput));
    console.error('=== STATUS exit:', exit2);
    console.error('=== Full log calls:', output.mock.calls);
  });
});
