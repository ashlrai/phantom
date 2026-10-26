import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdQueue } from '../src/cli/queue.js';
import type { QueueSnapshot } from '../src/core/queue/types.js';

let root: string;
let input: string;
let output: string;
let stdout: string;
let stderr: string;

function snapshot(): QueueSnapshot {
  return {
    schema: 'phantom-queue-snapshot/v1', stream: 'cli-test', observedAt: 1_000,
    windowSeconds: 10, plannerRate: 1, targetUtilization: 0.8,
    pools: [{ id: 'workers', slots: 4, available: true }],
    stages: [{ id: 'build', kind: 'work', pool: 'workers', queued: 5,
      previousQueued: 2, arrivals: 10, slots: 1, minSlots: 1, maxSlots: 4,
      tier: 'standard', tiers: [{ id: 'standard', serviceRate: 1 }],
      impact: false, batchSize: 1, batches: [] }],
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'phantom-queue-cli-'));
  input = join(root, 'snapshot.json');
  output = join(root, 'output');
  stdout = ''; stderr = '';
  writeFileSync(input, JSON.stringify(snapshot()), { mode: 0o600 });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk); return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk); return true;
  });
});

afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('queue control CLI', () => {
  it.each([['help'], ['--help'], ['-h'], ['control', '--help']])('help %j writes no state', async (...args) => {
    expect(await cmdQueue(args)).toBe(0);
    expect(stdout).toContain('phm queue control --input FILE');
    expect(stderr).toBe('');
    expect(existsSync(output)).toBe(false);
  });

  it.each([
    [], ['control'], ['unknown'], ['control', '--input'],
    ['control', '--input', 'file', '--out'],
    ['control', '--input', 'file', '--dry-run', '--wat'],
    ['control', '--input', 'file', '--dry-run', '--dry-run'],
    ['control', '--input', 'file', '--input', 'other', '--dry-run'],
    ['control', '--input', 'file', '--out', 'one', '--out', 'two'],
    ['control', '--input', 'file', '--dry-run', '--json', '--json'],
    ['control', '--input', 'file', '--dry-run', 'extra'],
  ])('rejects invalid arguments %j', async (...args) => {
    expect(await cmdQueue(args)).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('Invalid queue arguments');
    expect(existsSync(output)).toBe(false);
  });

  it('computes a dry run without creating the explicit output directory', async () => {
    expect(await cmdQueue(['control', '--input', input, '--out', output, '--dry-run', '--json'])).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.decision.schema).toBe('phantom-queue-control/v1');
    expect(result.decision.bottleneck.stage).toBe('build');
    expect(result.persistence).toBeNull();
    expect(existsSync(output)).toBe(false);
  });

  it('persists a real decision and reports an idempotent replay', async () => {
    const args = ['control', '--input', input, '--out', output, '--json'];
    expect(await cmdQueue(args)).toBe(0);
    const first = JSON.parse(stdout);
    expect(first.persistence.replayed).toBe(false);
    expect(readFileSync(first.persistence.path, 'utf8')).toContain(first.decision.id);
    stdout = '';
    expect(await cmdQueue(args)).toBe(0);
    const second = JSON.parse(stdout);
    expect(second.persistence.replayed).toBe(true);
    expect(second.decision).toEqual(first.decision);
  });

  it('renders readable control output', async () => {
    expect(await cmdQueue(['control', '--input', input, '--dry-run'])).toBe(0);
    expect(stdout).toContain('Bottleneck: build');
    expect(stdout).toContain('Planner:');
    expect(stdout).toContain('build: slots 1 -> 2');
    expect(stdout).toContain('Dry run: no files written.');
  });

  it.each(['missing', 'directory', 'oversized', 'malformed', 'invalid-schema'])('rejects %s input without persistence', async (kind) => {
    let path = input;
    if (kind === 'missing') path = join(root, 'absent');
    if (kind === 'directory') path = root;
    if (kind === 'oversized') writeFileSync(input, ' '.repeat(1024 * 1024 + 1));
    if (kind === 'malformed') writeFileSync(input, '{private-input-must-not-appear');
    if (kind === 'invalid-schema') writeFileSync(input, '{}');
    expect(await cmdQueue(['control', '--input', path, '--out', output, '--json'])).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).not.toContain('private-input-must-not-appear');
    expect(existsSync(output)).toBe(false);
  });

  it('fails when the output directory is a file', async () => {
    writeFileSync(output, 'existing file');
    expect(await cmdQueue(['control', '--input', input, '--out', output])).toBe(1);
    expect(stderr).toContain('could not be persisted');
    expect(readFileSync(output, 'utf8')).toBe('existing file');
  });
});
