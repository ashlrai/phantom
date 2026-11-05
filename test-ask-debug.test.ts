import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'cos-ask-debug-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(runsDir, { recursive: true, force: true }).catch(() => {}); });

describe('debug ask path', () => {
  it('should reveal what error happens', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('HOME', runsDir);
    process.env.ASHLR_RUNS_DIR = runsDir;
    console.error('=== ASHLR_RUNS_DIR:', process.env.ASHLR_RUNS_DIR);
    console.error('=== runsDir:', runsDir);

    // First, try the channel receiver directly
    const { createChannelReceiver } = await import('../src/core/fleet/channel-envelope.js');
    const { queueCosEnvelope, cosJobId } = await import('../src/core/cos/intake.js');
    const { QueueStore } = await import('../src/core/queue/store.js');

    const receive = createChannelReceiver({ 
      allowedSenderIds: new Set(['cos-local']), 
      publish: null 
    });

    const msg = { channel: 'cli' as const, verifiedSenderId: 'cos-local', body: 'Prepare a project brief' };
    const result = await receive(msg);
    console.error('=== receive result:', JSON.stringify(result, null, 2));
    
    if (result.ok) {
      const jobId = cosJobId(result.ack.dedupeKey);
      console.error('=== generated job ID:', jobId);
      
      // Check the queue
      const qs = new QueueStore(join(runsDir, 'queue'));
      const docs = await qs.read();
      console.error('=== queue jobs:', docs.jobs.map(j => j.id));
    } else {
      console.error('=== receive failed reason:', result.reason);
    }
  });
});
