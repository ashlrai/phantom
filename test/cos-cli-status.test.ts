import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'cos-cli-status-')); });
afterEach(async () => {
  process.env.ASHLR_RUNS_DIR = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(runsDir, { recursive: true, force: true }).catch(() => {});
});

describe('cos CLI status (with ASHLR_RUNS_DIR override)', () => {
  it('writes to ASHLR_RUNS_DIR and status reads the same queue', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('HOME', runsDir);
    process.env.ASHLR_RUNS_DIR = runsDir;

    const mod = await import('../src/cli/cos.js');
    const { QueueStore } = await import('../src/core/queue/store.js');
    const { cosStatus, cosJobId } = await import('../src/core/cos/intake.js');
    const { createChannelReceiver } = await import('../src/core/fleet/channel-envelope.js');

    const receiver = createChannelReceiver({ allowedSenderIds: new Set(['cos-local']), publish: null, runsDir });
    const result = await receiver({ channel: 'cli' as const, verifiedSenderId: 'cos-local', body: 'test message' });
    if (!result.ok) throw new Error(`Direct receive failed: ${result.reason}`);
    const directId = cosJobId(result.ack.dedupeKey);

    const qs = new QueueStore(join(runsDir, 'queue'));
    const docs = await qs.read();
    expect(docs.jobs).toHaveLength(1);
    expect(docs.jobs[0]!.id).toBe(directId);

    process.env.ASHLR_RUNS_DIR = runsDir;
    const cliExit = await mod.cmdCos('status', directId, '--json');
    expect(cliExit).toBe(0);
    const cliStatus = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(cliStatus.job.id).toBe(directId);
  });
});
