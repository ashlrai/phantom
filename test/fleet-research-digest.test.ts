import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleetResearchDigest } from '../src/cli/fleet-research-digest.js';

const NOW = new Date('2026-11-08T12:00:00Z');

const digest = `# Digest

## S1 — Spawn fleet model
- Checked: 2026-11-08.
- Source: [writeup](https://simonwillison.net/2026/oct/29/how-i-built-the-most-ai-pilled-company-in-the-world/)

## Proposals

- RQ-CLI-ONE | S1 | impact=4 effort=m confidence=high | Add triage mapping in src/core/fleet/lane-health.ts for flagged lanes. | Acceptance: npx vitest run test/lane-health.test.ts passes.
- RQ-CLI-TWO | S1 | impact=4 effort=s confidence=medium | Note a field in src/cli/fleet-eval-report.ts. | Acceptance: npm run check:docs passes.
`;

function fixture(): { dir: string; digestPath: string; queuePath: string; reposRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'research-digest-'));
  const digestPath = join(dir, 'digest.md');
  writeFileSync(digestPath, digest);
  const queuePath = join(dir, 'ready.md');
  writeFileSync(queuePath, '# queue\n');
  const reposRoot = join(dir, 'repos');
  mkdirSync(join(reposRoot, 'phantom'), { recursive: true });
  return { dir, digestPath, queuePath, reposRoot };
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  const se = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  try {
    const code = await cmdFleetResearchDigest(args, { now: () => NOW });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally { so.mockRestore(); se.mockRestore(); }
}

describe('phm fleet research-digest', () => {
  it('prints usage and exits 2 without --file', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['--file'])).code).toBe(2);
    expect((await run(['--bogus', 'x', '--file', 'a'])).code).toBe(2);
  });

  it('exits 1 for an unreadable digest', async () => {
    const { code, out } = await run(['--file', '/nonexistent/digest.md', '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(out).ok).toBe(false);
  });

  it('emits a scored, lint-verified plan in dry-run and writes nothing', async () => {
    const { dir, digestPath, queuePath, reposRoot } = fixture();
    const { code, out } = await run(['--file', digestPath, '--queue', queuePath, '--repos-root', reposRoot, '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(out);
    expect(report.ok).toBe(true);
    expect(report.applied).toBe(false);
    expect(report.proposals.map((p: { id: string }) => p.id)).toEqual(['RQ-CLI-ONE', 'RQ-CLI-TWO']);
    expect(report.proposals[0].ready).toContain('- READY RQ-CLI-ONE (P2, pool=codex-personal, tier=work, repo=phantom, after none, research-digest):');
    expect(report.proposals[0].ready).toContain('Provenance: digest.md S1; score 3.5');
    expect(report.queued).toEqual([]);
    expect(readFileSync(queuePath, 'utf8')).toBe('# queue\n');
    void dir;
  });

  it('--apply appends only lint-passed lines and dedups on rerun', async () => {
    const { digestPath, queuePath, reposRoot } = fixture();
    const first = await run(['--file', digestPath, '--queue', queuePath, '--repos-root', reposRoot, '--apply', '--json']);
    expect(first.code).toBe(0);
    const applied = JSON.parse(first.out);
    expect(applied.applied).toBe(true);
    expect(applied.queued).toEqual(['RQ-CLI-ONE', 'RQ-CLI-TWO']);
    const queueText = readFileSync(queuePath, 'utf8');
    expect(queueText).toMatch(/enq=\d+/);
    expect(queueText).toContain('- READY RQ-CLI-ONE');
    expect(queueText).toContain('- READY RQ-CLI-TWO');
    const second = await run(['--file', digestPath, '--queue', queuePath, '--repos-root', reposRoot, '--apply', '--json']);
    expect(JSON.parse(second.out).queued).toEqual([]);
    expect(readFileSync(queuePath, 'utf8')).toBe(queueText);
  });

  it('--approve restricts apply to named ids', async () => {
    const { digestPath, queuePath, reposRoot } = fixture();
    const { code, out } = await run(['--file', digestPath, '--queue', queuePath, '--repos-root', reposRoot, '--apply', '--approve', 'RQ-CLI-TWO', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out).queued).toEqual(['RQ-CLI-TWO']);
    expect(readFileSync(queuePath, 'utf8')).not.toContain('RQ-CLI-ONE');
    expect(readFileSync(queuePath, 'utf8')).toContain('- READY RQ-CLI-TWO');
  });

  it('requires --queue with --apply', async () => {
    const { digestPath } = fixture();
    const { code } = await run(['--file', digestPath, '--apply']);
    expect(code).toBe(2);
  });
});
