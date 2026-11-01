/**
 * dirty-union-apply.test.ts — the mechanical resolver behind
 * `ashlr fleet union-apply`: add-only hunks union in a stable ours-first
 * order, every other shape refuses the whole file.
 */
import { describe, expect, it } from 'vitest';
import { resolveUnionMerge } from '../src/core/fleet/dirty-union-apply.js';
import { renderBacklogRecutJob } from '../src/core/fleet/backlog-recut-job.js';

describe('resolveUnionMerge', () => {
  it('merges add-only changes on both sides, ours first', () => {
    const merged = resolveUnionMerge('start\nend\n', 'start\nours\nend\n', 'start\ntheirs\nend\n');
    expect(merged).toEqual({ ok: true, text: 'start\nours\ntheirs\nend\n' });
  });

  it('keeps identical additions once', () => {
    expect(resolveUnionMerge('a\n', 'a\nnew\n', 'a\nnew\n')).toEqual({ ok: true, text: 'a\nnew\n' });
  });

  it('dedupes a line both sides add in the same hunk', () => {
    const merged = resolveUnionMerge('a\nend\n', 'a\nX\nY\nend\n', 'a\nX\nZ\nend\n');
    expect(merged).toEqual({ ok: true, text: 'a\nX\nY\nZ\nend\n' });
  });

  it('emits a boundary insertion once when the same side contested the region', () => {
    // The repeated base line makes ours' whole change one region; theirs'
    // trailing x inserts at that region's end offset and must not be emitted
    // both inside the union span and again as its own run.
    const merged = resolveUnionMerge('a\na\n', 'b\na\na\nb\n', 'a\nb\na\nx\n');
    expect(merged).toEqual({ ok: true, text: 'b\na\na\nb\nx\n' });
  });

  it('applies non-overlapping edits without a hunk', () => {
    const merged = resolveUnionMerge('a\nb\nc\n', 'a\nP\nb\nc\n', 'a\nb\nc\nQ\n');
    expect(merged).toEqual({ ok: true, text: 'a\nP\nb\nc\nQ\n' });
  });

  it('refuses a deletion that collides with an edit', () => {
    const merged = resolveUnionMerge('a\nx\nb\n', 'a\nb\n', 'a\ny\nb\n');
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.reason).toContain('hunk 1');
  });

  it('preserves CRLF and a missing trailing newline', () => {
    const merged = resolveUnionMerge('a\r\nb', 'a\r\nx\r\nb', 'a\r\ny\r\nb');
    expect(merged).toEqual({ ok: true, text: 'a\r\nx\r\ny\r\nb' });
  });

  it('refuses the whole file when one hunk is not union-safe', () => {
    // ours adds P and deletes y; theirs adds Q and rewrites y — the first hunk
    // unions cleanly, the second names the file's first needs-model hunk.
    const merged = resolveUnionMerge('a\nx\nb\ny\nc\n', 'a\nP\nx\nb\nc\n', 'a\nQ\nx\nb\nZ\nc\n');
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.hunk).toBe(2);
  });

  it('is deterministic — same inputs, byte-identical output', () => {
    const args = ['i\nj\nk\n', 'i\nA\nj\nk\nB\n', 'i\nC\nj\nk\nD\n'] as const;
    const first = resolveUnionMerge(args[0], args[1], args[2]);
    expect(resolveUnionMerge(args[0], args[1], args[2])).toEqual(first);
    expect(first).toEqual({ ok: true, text: 'i\nA\nC\nj\nk\nB\nD\n' });
  });
});

describe('renderBacklogRecutJob union line', () => {
  it('names the union-apply command only for a union-safe PR', () => {
    const body = renderBacklogRecutJob(2523, 'abc123', 'bridge: RQ-PHX-EXAMPLE', { unionSafe: true });
    expect(body).toContain('ashlr fleet union-apply --pr 2523 --out <dir>');
    expect(renderBacklogRecutJob(2523, 'abc123', 'bridge: RQ-PHX-EXAMPLE')).not.toContain('union-apply');
  });
});
