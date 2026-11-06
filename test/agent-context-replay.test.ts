import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { runContextReplay } from '../examples/agents/context-replay.js';
import { buildNodeContextPack } from '../src/core/fleet/node-context-pack.js';

const fixture = {
  node: { jobId: 'current', upstreamJobIds: ['upstream', 'missing'] },
  tasks: [{ jobId: 'current', text: 'review the result' }],
  outputs: [
    { jobId: 'upstream', text: '🙂漢字'.repeat(100) },
    { jobId: 'current', text: 'OWN OUTPUT SHOULD NOT APPEAR' },
  ],
  byteBudget: 1024,
};

function run(args: string[], value: unknown = fixture) {
  let out = '', err = '';
  const read = vi.fn(() => ({ ok: true as const, text: JSON.stringify(value), bytesRead: 0, mtimeMs: 0 }));
  const build = vi.fn(buildNodeContextPack);
  const code = runContextReplay(args, { read, build, stdout: text => { out += text; }, stderr: text => { err += text; } });
  return { code, out, err, read, build };
}

describe('agent context replay', () => {
  it('replays one scrubbed snapshot with exact UTF-8 budgets and reports omissions', () => {
    const result = run(['--file', 'fixture.json', '--budgets', '80,4096']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.read).toHaveBeenCalledTimes(1);
    expect(result.build).toHaveBeenCalledTimes(2);
    const report = JSON.parse(result.out);
    const [small, large] = report.reports;
    const smallPack = buildNodeContextPack({ ...fixture, byteBudget: 80 });
    expect(small.bytes).toBe(Buffer.byteLength(smallPack, 'utf8'));
    expect(small.bytes).toBeLessThanOrEqual(80);
    expect(small.truncatedCitations).toEqual([{ jobId: 'upstream', kind: 'output' }]);
    expect(small.missingUpstreamIds).toEqual(['missing']);
    expect(large.includedCitations).toEqual([
      { jobId: 'upstream', kind: 'output' }, { jobId: 'current', kind: 'task' },
    ]);
    expect(large.missingUpstreamIds).toEqual(['missing']);
    expect(large.truncatedCitations).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('OWN OUTPUT');
  });

  it('shows budget-omitted upstream IDs and keeps a selected pack pipeable', () => {
    const result = run(['--file', 'fixture.json', '--budgets', '1,80', '--emit-budget', '80']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(buildNodeContextPack({ ...fixture, byteBudget: 80 }));
    const report = JSON.parse(result.err);
    expect(report.reports[0].missingUpstreamIds).toEqual(['upstream', 'missing']);
    expect(report.reports[1].bytes).toBe(Buffer.byteLength(result.out, 'utf8'));
    expect(result.out).not.toContain('OWN OUTPUT');
    expect(result.out.trim().split('\n').map(line => JSON.parse(line))).toHaveLength(1);
  });

  it.each(['', '0', '-1', '1,', '1,1', '1.5', '1e3', '32769', Array(17).fill('1').join(',')])(
    'rejects malformed budgets %s before reading or building', budget => {
      const result = run(['--file', 'fixture.json', '--budgets', budget]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.err).error.code).toBe('INVALID_ARGUMENTS');
      expect(result.out).toBe('');
      expect(result.read).not.toHaveBeenCalled();
      expect(result.build).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid snapshots and emit selections before building', () => {
    const badSnapshot = run(['--file', 'fixture.json', '--budgets', '100'], { ...fixture, extra: true });
    expect(badSnapshot.code).toBe(2);
    expect(badSnapshot.build).not.toHaveBeenCalled();
    const badSelection = run(['--file', 'fixture.json', '--budgets', '100', '--emit-budget', '101']);
    expect(badSelection.code).toBe(2);
    expect(badSelection.read).not.toHaveBeenCalled();
  });

  it('uses the existing validator to scrub source data before packing and reporting', () => {
    const data = { ...fixture, outputs: [{ jobId: 'upstream', text: 'contact fake@example.com' }] };
    const result = run(['--file', 'fixture.json', '--budgets', '500', '--emit-budget', '500'], data);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('fake@example.com');
    expect(result.err).not.toContain('fake@example.com');
  });

  it('runs as an executable with a stable file and separate output streams', () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-replay-'));
    try {
      const file = join(dir, 'snapshot.json');
      writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 });
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'examples/agents/context-replay.ts',
        '--file', file, '--budgets', '80,4096', '--emit-budget', '80'], { encoding: 'utf8', timeout: 15000 });
      expect(child.status).toBe(0);
      expect(child.stdout).toBe(buildNodeContextPack({ ...fixture, byteBudget: 80 }));
      expect(JSON.parse(child.stderr).reports).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20000);
});
