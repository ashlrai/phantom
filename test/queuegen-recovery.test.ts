import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, it } from 'vitest';

const worker = `
import * as fs from 'node:fs';
import { runQueuegenCycle, withQueuegenLock } from ${JSON.stringify(new URL('../src/core/drive/queuegen.ts', import.meta.url).href)};
import { rebaseWorkState } from ${JSON.stringify(new URL('../src/core/fleet/rebase-plan.ts', import.meta.url).href)};
import { readRebaseCoverage } from ${JSON.stringify(new URL('../src/cli/fleet-rebase-plan.ts', import.meta.url).href)};
const [root, mode] = process.argv.slice(1), queue = root + '/router-queue.md';
const result = await withQueuegenLock(queue, async () => {
  if (mode === 'hold') { process.send('locked'); await new Promise(r => process.once('message', r)); }
  const coverage = await readRebaseCoverage(root, p => Promise.resolve(fs.readFileSync(p, 'utf8')));
  return runQueuegenCycle({
    listPullRequests: () => [{ number: 1, headRef: 'fleet/fix', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      author: 'ashlr-fleet[bot]', mergeState: 'DIRTY', files: ['a.ts'] }],
    readRebaseWork: () => rebaseWorkState(coverage.jobs, ['ashlrai/phantom']),
    readQueueIds: () => new Set(coverage.jobs.map(j => j.id)),
    readHoldList: () => new Set(), conflictFiles: () => ['a.ts'],
    appendQueueLine: line => fs.appendFileSync(queue, line + '\\n'),
    loadState: () => fs.existsSync(root + '/state') ? JSON.parse(fs.readFileSync(root + '/state', 'utf8')) : undefined,
    saveState: state => { if (mode === 'crash') process.exit(9); fs.writeFileSync(root + '/state', JSON.stringify(state)); },
    log: () => {}, now: () => Date.now(), checks: () => [], checkLogTail: () => '',
  }, { repos: ['ashlrai/phantom'] });
});
process.stdout.write(JSON.stringify(result));
process.disconnect();
`;

function start(root: string, mode = 'normal') {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, root, mode],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', errors = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { errors += chunk; });
  const done = once(child, 'close').then(([code]) => {
    if (errors) expect(errors).toContain('Error: QUEUEGEN_LOCK_UNAVAILABLE');
    return { code, result: output ? JSON.parse(output) : undefined };
  });
  return { child, done };
}

it('serializes dispatch and recovers an append before state save, then retries a failed attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'queuegen-recovery-'));
  const held = start(root, 'hold');
  try {
    await Promise.race([once(held.child, 'message'), held.done.then(() => { throw new Error('holder exited'); })]);
    const overlap = await start(root).done;
    // Native owner probes may be unavailable (e.g. sandboxed ps); both outcomes refuse work.
    expect(overlap).toEqual(overlap.code === 0 ? { code: 0, result: null } : { code: 1, result: undefined });
    expect(() => readFileSync(join(root, 'router-queue.md'))).toThrow();
    held.child.send('run');
    expect((await held.done).result.emitted).toBe(1);
    // A fresh process uses durable queue evidence, independently of cooldown state.
    rmSync(join(root, 'state'));
    expect((await start(root).done).result.emitted).toBe(0);
    const line = readFileSync(join(root, 'router-queue.md'), 'utf8');
    const id = line.split(' ')[2];
    writeFileSync(join(root, 'ready.tsv'), `FAILED\t${id}\tdevin\twork\tphantom\n`);
    expect((await start(root, 'crash').done).code).toBe(9);
    expect((await start(root).done).result.emitted).toBe(0);
    const lines = readFileSync(join(root, 'router-queue.md'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`${id}-retry1 `);
  } finally {
    if (held.child.exitCode === null) held.child.kill('SIGKILL');
    await held.done;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
