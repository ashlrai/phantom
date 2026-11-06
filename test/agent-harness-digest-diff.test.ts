import { describe, expect, it, vi } from 'vitest';
import { runHarnessDigestDiff } from '../examples/agents/harness-digest-diff.js';
import { parseHarnessDigest } from '../src/core/learn/harness-digest-reader.js';

const now = new Date('2026-10-31T12:00:00Z');
const source = (id: string, body = '', checked = '2026-10-30') =>
  `## ${id} — Fixture ${id}\n- Checked: ${checked}.\n- Source: [one](https://example.test/one) [two](https://example.test/two)\n${body}\n`;

function run(before: string | null, after: string | null, args = ['--before', 'old', '--after', 'new']) {
  let stdout = '';
  let stderr = '';
  const read = vi.fn((file: string, clock: Date) => {
    const content = file === 'old' ? before : after;
    return content === null ? null : parseHarnessDigest(content, clock);
  });
  const status = runHarnessDigestDiff(args, {
    read, now: () => now,
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
  });
  return { status, stdout, stderr, read, result: stdout ? JSON.parse(stdout) : null };
}

describe('harness digest diff', () => {
  it('ignores source, URL, and takeaway ordering', () => {
    const one = source('S1', '- Takeaway: Alpha\n- Takeaway: Beta');
    const reordered = one.replace('[one](https://example.test/one) [two](https://example.test/two)', '[two](https://example.test/two) [one](https://example.test/one)')
      .replace('- Takeaway: Alpha\n- Takeaway: Beta', '- Takeaway: Beta\n- Takeaway: Alpha');
    const { status, result } = run(one + source('S2'), source('S2') + reordered);
    expect(status).toBe(0);
    expect(result).toMatchObject({ addedSources: [], removedSources: [], checkedDateChanges: [], semanticChanges: [], ambiguousSources: [] });
  });

  it('reports takeaway and URL changes with the original source provenance', () => {
    const before = source('S1', '- Takeaway: Old');
    const after = source('S1', '- Takeaway: New').replace('https://example.test/two', 'https://example.test/three');
    const { result } = run(before + source('S2'), after + source('S3'));
    expect(result.addedSources.map((item: { id: string }) => item.id)).toEqual(['S3']);
    expect(result.removedSources.map((item: { id: string }) => item.id)).toEqual(['S2']);
    expect(result.semanticChanges).toEqual([expect.objectContaining({
      id: 'S1', addedTakeaways: ['New'], removedTakeaways: ['Old'],
      addedUrls: ['https://example.test/three'], removedUrls: ['https://example.test/two'],
      before: expect.objectContaining({ urls: ['https://example.test/one', 'https://example.test/two'] }),
      after: expect.objectContaining({ urls: ['https://example.test/one', 'https://example.test/three'] }),
    })]);
  });

  it('reports changed checked dates separately, retaining reader health for invalid dates', () => {
    const { result } = run(source('S1'), source('S1', '', '2026-02-30'));
    expect(result.checkedDateChanges).toEqual([{ id: 'S1', before: '2026-10-30', after: null }]);
    expect(result.semanticChanges).toEqual([]);
    expect(result.health.after).toContainEqual({ id: 'S1', code: 'invalid_checked' });
  });

  it('marks duplicates on either side ambiguous without inventing pairings', () => {
    const { result } = run(source('S1', '- Takeaway: First') + source('S1', '- Takeaway: Second') + source('S2'), source('S1') + source('S3') + source('S3'));
    expect(result.ambiguousSources.map((item: { id: string }) => item.id)).toEqual(['S1', 'S3']);
    expect(result.ambiguousSources[0].before).toHaveLength(2);
    expect(result.ambiguousSources[1].after).toHaveLength(2);
    expect(result.addedSources).toEqual([]);
    expect(result.removedSources.map((item: { id: string }) => item.id)).toEqual(['S2']);
    expect(result.semanticChanges).toEqual([]);
    expect(result.health.before).toContainEqual({ id: 'S1', code: 'duplicate_id' });
  });

  it('surfaces truncated takeaways even when the retained comparison is identical', () => {
    const fixture = source('S1', Array.from({ length: 21 }, (_, i) => `- Takeaway: Note ${i}`).join('\n'));
    const { result } = run(fixture, fixture);
    expect(result.semanticChanges).toEqual([]);
    expect(result.truncatedTakeaways.before[0]).toMatchObject({ id: 'S1', takeawaysTruncated: { count: true } });
    expect(result.truncatedTakeaways.after).toHaveLength(1);
  });

  it('fails clearly for unavailable input without exposing paths or emitting partial output', () => {
    for (const [before, after, message] of [[null, source('S1'), 'Before'], [source('S1'), null, 'After']] as const) {
      const { status, stderr, stdout } = run(before, after);
      expect(status).toBe(1);
      expect(stdout).toBe('');
      expect(JSON.parse(stderr).error).toContain(message);
      expect(stderr).not.toContain('old');
      expect(stderr).not.toContain('new');
    }
    let stderr = '';
    expect(runHarnessDigestDiff(['--before', '/no/such/fake-digest', '--after', '/no/such/other'], { stderr: (s) => { stderr += s; } })).toBe(1);
    expect(JSON.parse(stderr).error).toContain('Before');
  });

  it('rejects invalid options before reading and accepts either argument order', () => {
    for (const args of [[], ['--before', 'old'], ['--before', 'old', '--before', 'new'], ['--before', '--after', '--after', 'new'], ['--after', 'x'.repeat(4097), '--before', 'old']]) {
      const response = run('', '', args);
      expect(response.status).toBe(2);
      expect(JSON.parse(response.stderr).error).toContain('Usage:');
      expect(response.read).not.toHaveBeenCalled();
    }
    expect(run(source('S1'), source('S2'), ['--after', 'new', '--before', 'old']).result.addedSources[0].id).toBe('S2');
  });

  it('does not fetch or execute untrusted source text', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const value = '$(touch /tmp/fake-harness-digest-diff)';
      const { result } = run(source('S1'), source('S1', `- Takeaway: ${value}`));
      expect(result.semanticChanges[0].addedTakeaways).toEqual([value]);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
