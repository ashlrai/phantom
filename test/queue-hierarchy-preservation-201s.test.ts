import { describe, expect, it } from 'vitest';
import { exportMarkdown, importMarkdown } from '../src/core/queue/markdown.js';
import { validateQueue, type QueueJob } from '../src/core/queue/schema.js';

const job = (extra: Partial<QueueJob> = {}): QueueJob => ({
  id: 'RQ-CHILD', status: 'READY', priority: 'P2', pool: 'local', tier: 'work',
  repo: 'fake', deps: [], scope: 'Do the work', acceptance: 'Tests pass', claims: [], ...extra,
});
const document = (entry: QueueJob) => ({ schema: 'queue.v1' as const, jobs: [entry] });

describe('queue hierarchy preservation', () => {
  it('round trips an imported child through an edited export without losing other text', () => {
    const text = '# Queue\r\n\r\n- READY RQ-CHILD (priority=P2, pool=local, tier=work, repo=fake, parent=RQ-PARENT, depth=1, custom=kept, worker=fake-worker, claimed=2026-01-01T00:00:00Z): Do the work Acceptance: Tests pass <!-- comment -->\r\n- MYSTERY RQ-RAW: leave alone\r\n';
    const doc = importMarkdown(text);
    expect(exportMarkdown(doc)).toBe(text);
    expect(doc.jobs[0]).toMatchObject({ parent: 'RQ-PARENT', depth: 1, scope: 'Do the work', claims: [{ owner: 'fake-worker' }] });
    doc.jobs[0]!.status = 'CLAIMED';
    const edited = exportMarkdown(doc);
    expect(edited).toContain('custom=kept');
    expect(edited).toContain('<!-- comment -->');
    expect(edited).toContain('- MYSTERY RQ-RAW: leave alone\r\n');
    const again = importMarkdown(edited);
    expect(again.jobs[0]).toMatchObject({ status: 'CLAIMED', parent: 'RQ-PARENT', depth: 1, scope: 'Do the work', claims: [{ owner: 'fake-worker' }] });
  });

  it('serializes new children and leaves older parentless jobs compatible', () => {
    for (const entry of [job(), job({ parent: 'RQ-PARENT', depth: 64 })]) {
      const doc = document(entry);
      expect(() => validateQueue(doc)).not.toThrow();
      const parsed = importMarkdown(exportMarkdown(doc)).jobs[0]!;
      expect(parsed.parent).toBe(entry.parent);
      expect(parsed.depth).toBe(entry.depth);
      expect(parsed.scope).toBe(entry.scope);
    }
  });

  it.each([{ parent: 'RQ-CHILD' }, { parent: 'bad id!' }, { depth: -1 }, { depth: 1.5 }, { depth: 65 }, { depth: Number.MAX_SAFE_INTEGER + 1 }])('rejects invalid hierarchy %j', fields => {
    expect(() => validateQueue(document(job(fields)))).toThrow();
  });

  it('retains malformed job-shaped lines and preserves ignored malformed routing bytes', () => {
    const text = '- READY RQ-CHILD (parent=bad id!, depth=-1): Work Acceptance: Done\n- UNKNOWN RQ-RAW: untouched\n';
    const doc = importMarkdown(text);
    expect(doc.jobs[0]).not.toHaveProperty('parent');
    expect(doc.jobs[0]).not.toHaveProperty('depth');
    expect(doc.raw?.[0]?.text).toBe('- UNKNOWN RQ-RAW: untouched');
    expect(exportMarkdown(doc)).toBe(text);
    expect(() => importMarkdown('- READY RQ-CHILD (depth=65): Work Acceptance: Done\n')).toThrow('Invalid depth');
  });
});
