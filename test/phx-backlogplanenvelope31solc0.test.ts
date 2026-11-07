import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdBacklog } from '../src/cli/backlog.js';
import { formatRqQueue, rqDigest, type RqJob } from '../src/core/portfolio/rq-backlog.js';

const config = { v: 1, activeSlots: 1, allowedRepos: Array.from({ length: 7 }, (_, i) => `ashlrai/repo-${i}`) };
const input = {
  v: 1, repositories: [{
    repo: config.allowedRepos[0], vision: '- [ ] Restore offline search',
    issues: Array.from({ length: 6 }, (_, i) => ({ number: i + 1, title: `Fix defect ${i + 1}`, state: 'open', body: 'Reproduce and fix.' })),
    scans: [{ id: 'scan-1', title: 'Improve coverage', detail: 'Test the parser.', source: 'test', value: 4, effort: 2 }],
  }],
};
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rq-envelope-'));
  directories.push(directory);
  const configPath = join(directory, 'config.json');
  const inputPath = join(directory, 'sources.json');
  const queuePath = join(directory, 'queue.md');
  const previousPath = join(directory, 'previous.md');
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(inputPath, JSON.stringify(input));
  writeFileSync(queuePath, '');
  return { directory, configPath, inputPath, queuePath, previousPath,
    args: ['plan', '--config', configPath, '--input', inputPath, '--queue', queuePath] };
}

async function run(args: string[]) {
  let stdout = '';
  let stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(console, 'log').mockImplementation((message) => { stdout += `${String(message)}\n`; });
  vi.spyOn(console, 'error').mockImplementation((message) => { stderr += `${String(message)}\n`; });
  try { return { code: await cmdBacklog(args), stdout, stderr }; }
  finally { vi.restoreAllMocks(); }
}

describe('backlog plan JSON envelope', () => {
  it('reports the real ordered plan, capacity, digests and audit without modifying inputs', async () => {
    const f = fixture();
    const before = [f.configPath, f.inputPath, f.queuePath].map((path) => readFileSync(path, 'utf8'));
    const legacy = await run(f.args);
    const result = await run([...f.args, '--report-json']);
    const report = JSON.parse(result.stdout);
    const logs = legacy.stderr.trim().split('\n').map((line) => JSON.parse(line));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(report).toMatchObject({ v: 1, event: 'rq-plan-report', status: 'ok', capacity: logs[1], audits: [logs[0]],
      digests: { source: rqDigest(before[1]!), queue: rqDigest(before[2]!) } });
    expect(report.items).toEqual(legacy.stdout.trim().split('\n').map((line) => JSON.parse(line)));
    expect(report.items).toHaveLength(5);
    expect([f.configPath, f.inputPath, f.queuePath].map((path) => readFileSync(path, 'utf8'))).toEqual(before);
  });

  it('keeps empty capacity distinct from exhaustion and rejected queues', async () => {
    const f = fixture();
    writeFileSync(f.configPath, JSON.stringify({ ...config, activeSlots: 0 }));
    const empty = await run([...f.args, '--report-json']);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toMatchObject({ status: 'ok', items: [], capacity: { ready: 0, target: 0, shortfall: 0 }, audits: [{ added: [] }] });
    writeFileSync(f.configPath, JSON.stringify(config));
    writeFileSync(f.inputPath, JSON.stringify({ v: 1, repositories: [] }));
    const exhausted = await run([...f.args, '--report-json']);
    expect(exhausted.code).toBe(1);
    expect(JSON.parse(exhausted.stdout)).toMatchObject({ status: 'ok', items: [], capacity: { target: 5, shortfall: 5 } });
    writeFileSync(f.inputPath, JSON.stringify({ ...input, repositories: [{ ...input.repositories[0], vision: '', issues: input.repositories[0]!.issues.slice(0, 1), scans: [] }] }));
    const partialLegacy = await run(f.args);
    const partial = await run([...f.args, '--report-json']);
    expect(partial.code).toBe(1);
    expect(JSON.parse(partial.stdout)).toMatchObject({ status: 'ok', items: [JSON.parse(partialLegacy.stdout)], capacity: { added: 1, shortfall: 4 } });
    writeFileSync(f.queuePath, 'PRIVATE_QUEUE_CONTENT');
    const rejected = await run([...f.args, '--report-json']);
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toBe('');
    expect(JSON.parse(rejected.stdout)).toMatchObject({ v: 1, status: 'error', error: { code: 'invalid-snapshot' },
      audits: [{ event: 'rq-queue-read', verdict: 'reject', beforeSha: rqDigest(''), sha: rqDigest('PRIVATE_QUEUE_CONTENT') }] });
    expect(rejected.stdout).not.toContain('PRIVATE_QUEUE_CONTENT');
    expect(rejected.stdout).not.toContain(f.directory);
  });

  it('preserves both audit records for a previous snapshot, including a rejected previous snapshot', async () => {
    const f = fixture();
    const legacy = await run(f.args);
    const job = JSON.parse(legacy.stdout.split('\n')[0]!) as RqJob;
    const previous = formatRqQueue([job]);
    const queue = formatRqQueue([{ ...job, status: 'RUNNING', prompt: 'PRIVATE_QUEUE_TASK' }]);
    writeFileSync(f.previousPath, previous);
    writeFileSync(f.queuePath, queue);
    const args = [...f.args, '--previous-queue', f.previousPath];
    const defaultRun = await run(args);
    const result = await run([...args, '--report-json']);
    const report = JSON.parse(result.stdout);
    expect(result.code).toBe(0);
    expect(report.audits).toEqual(defaultRun.stderr.trim().split('\n').slice(0, 2).map((line) => JSON.parse(line)));
    expect(report.audits[1]).toMatchObject({ beforeSha: rqDigest(previous), sha: rqDigest(queue), changed: [expect.any(Object)] });
    expect(result.stdout).not.toContain('PRIVATE_QUEUE_TASK');
    writeFileSync(f.previousPath, 'PRIVATE_PREVIOUS_CONTENT');
    const rejected = await run([...args, '--report-json']);
    expect(rejected.code).toBe(2);
    expect(JSON.parse(rejected.stdout).audits).toEqual([{ event: 'rq-queue-read', beforeSha: rqDigest(''), sha: rqDigest('PRIVATE_PREVIOUS_CONTENT'), verdict: 'reject' }]);
    expect(rejected.stdout).not.toContain('PRIVATE_PREVIOUS_CONTENT');
  });

  it.each(['configPath', 'inputPath', 'queuePath'] as const)('returns a versioned error for malformed %s without leaking contents or paths', async (key) => {
    const f = fixture();
    writeFileSync(f[key], 'PRIVATE_MALFORMED_CONTENT');
    const result = await run(['plan', '--report-json', ...f.args.slice(1)]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ v: 1, event: 'rq-plan-report', status: 'error', error: { code: 'invalid-snapshot' } });
    expect(result.stdout).not.toContain('PRIVATE_MALFORMED_CONTENT');
    expect(result.stdout).not.toContain(f.directory);
  });

  it.each([
    ['--unknown'], ['--report-json'], ['--queue', 'other'], ['--input'], ['--help'], ['--previous-queue', '-x'],
  ])('rejects unknown, repeated or incomplete flags in report mode: %s', async (...extra) => {
    const f = fixture();
    const result = await run([...f.args, '--report-json', ...extra]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ v: 1, status: 'error', error: { code: 'usage' }, audits: [] });
  });
});
