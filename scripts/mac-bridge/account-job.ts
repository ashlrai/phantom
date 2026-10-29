/** Source runner: npx tsx scripts/mac-bridge/account-job.ts jobs.jsonl JOB POOL -- command args... */
import { spawn } from 'node:child_process';
import { appendMemoryJobRecord, startJobMemorySampling } from '../../src/core/memory/job-accounting.js';

const [path, jobId, pool, separator, command, ...args] = process.argv.slice(2);
if (!path || !jobId || !pool || separator !== '--' || !command) {
  throw new Error('Usage: account-job.ts jobs.jsonl JOB POOL -- command args...');
}
const startedAt = new Date().toISOString();
const child = spawn(command, args, { stdio: 'inherit' });
const sampler = child.pid ? startJobMemorySampling(child.pid) : undefined;
const interrupt = (): void => { child.kill('SIGINT'); };
const terminate = (): void => { child.kill('SIGTERM'); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
child.once('error', () => { process.exitCode = 127; });
child.once('close', async (code, signal) => {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 127);
  if (!sampler) return;
  try {
    const memory = await sampler.stop();
    await appendMemoryJobRecord(path, {
      schemaVersion: 1, jobId, pool, startedAt, finishedAt: new Date().toISOString(), memory,
    });
  } catch {
    console.error('Job memory accounting could not be persisted');
    if (!process.exitCode) process.exitCode = 1;
  }
});
