/**
 * RQ-PHX-QUEUEROWPRESERVE210S — queue.v1 row projection preserved from PR #5243.
 *
 * Source: ashlrai/phantom PR #5243 head 319c7fa8f9152e21dcfd71fb4aeca87466bf6cc4,
 * test/workbench-fleet-view.test.ts "queue.v1 row projection" describe block,
 * ported onto master's parseQueueV1Document (test/workbench-fleet-view.test.ts
 * on master does not carry that case).
 *
 * Contract under test (production parser only — no mocks, no unmerged imports):
 *   - parseQueueV1Document returns `rows` — validated job rows in document
 *     order — alongside the unchanged live/ready/jobPool/jobs aggregates.
 *   - Rows carry an uppercase status, optional repo/tier/priority metadata
 *     (absent stays absent), and a bounded (≤240 char) summary that prefers
 *     `title` and otherwise takes `task`'s first line.
 *   - Malformed jobs are rejected exactly as before; the row projection adds
 *     no persistence and no side effects.
 */

import { describe, expect, it } from 'vitest';

import { parseQueueV1Document, type QueueV1JobRow } from '../src/core/fleet/lane-console.js';

describe('queue.v1 row projection (preserved from #5243)', () => {
  it('parseQueueV1Document carries validated rows with bounded summaries', () => {
    const read = parseQueueV1Document(JSON.stringify({
      schema: 'queue.v1',
      jobs: [
        { id: 'RQ-1', status: 'claimed', pool: 'devin', repo: 'phantom', tier: 'work', priority: 'P0', task: 'first line\nsecond line' },
        { id: 'RQ-2', status: 'READY', pool: 'devin' },
      ],
    }));
    expect(read.rows).toHaveLength(2);
    expect(read.rows[0]).toMatchObject({
      id: 'RQ-1', status: 'CLAIMED', pool: 'devin', repo: 'phantom', summary: 'first line',
    });
    expect(read.rows[1].summary).toBeUndefined();
  });

  it('rows are ordered and absent optional fields stay absent', () => {
    const read = parseQueueV1Document(JSON.stringify({
      schema: 'queue.v1',
      jobs: [
        { id: 'RQ-1', status: 'READY', pool: 'devin' },
        { id: 'RQ-2', status: 'CLAIMED', pool: 'codex-personal' },
      ],
    }));
    expect(read.rows.map(r => r.id)).toEqual(['RQ-1', 'RQ-2']);
    expect(read.rows[0]).toEqual({ id: 'RQ-1', status: 'READY', pool: 'devin' });
    expect(read.rows[1]).toEqual({ id: 'RQ-2', status: 'CLAIMED', pool: 'codex-personal' });
    const bare: QueueV1JobRow = read.rows[0]!;
    expect('repo' in bare).toBe(false);
    expect('tier' in bare).toBe(false);
    expect('priority' in bare).toBe(false);
    expect('summary' in bare).toBe(false);
  });

  it('title takes precedence over task for the summary', () => {
    const read = parseQueueV1Document(JSON.stringify({
      schema: 'queue.v1',
      jobs: [
        { id: 'RQ-1', status: 'READY', pool: 'devin', title: 'from title', task: 'from task\nmore task' },
      ],
    }));
    expect(read.rows[0]!.summary).toBe('from title');
  });

  it('multiline task summaries use only the first line', () => {
    const read = parseQueueV1Document(JSON.stringify({
      schema: 'queue.v1',
      jobs: [
        { id: 'RQ-1', status: 'READY', pool: 'devin', task: 'first line\nsecond line\nthird line' },
      ],
    }));
    expect(read.rows[0]!.summary).toBe('first line');
  });

  it('summaries are bounded to 240 characters', () => {
    const longTitle = 'x'.repeat(300);
    const read = parseQueueV1Document(JSON.stringify({
      schema: 'queue.v1',
      jobs: [
        { id: 'RQ-1', status: 'READY', pool: 'devin', title: longTitle },
        { id: 'RQ-2', status: 'READY', pool: 'devin', task: `${'y'.repeat(241)}\ntrailing` },
      ],
    }));
    expect(read.rows[0]!.summary).toBe(longTitle.slice(0, 240));
    expect(read.rows[0]!.summary).toHaveLength(240);
    expect(read.rows[1]!.summary).toHaveLength(240);
  });

  it('a job with neither title nor task has no summary', () => {
    const read = parseQueueV1Document(JSON.stringify({
      schema: 'queue.v1',
      jobs: [{ id: 'RQ-1', status: 'READY', pool: 'devin' }],
    }));
    expect(read.rows[0]!.summary).toBeUndefined();
  });

  it('aggregate counts are unchanged by the row projection', () => {
    const doc = JSON.stringify({
      schema: 'queue.v1',
      jobs: [
        { id: 'RQ-1', status: 'claimed', pool: 'devin', title: 'one' },
        { id: 'RQ-2', status: 'READY', pool: 'devin', task: 'two\nlines' },
        { id: 'RQ-3', status: 'PR-OPEN', pool: 'codex-personal', priority: 'P0' },
        { id: 'RQ-4', status: 'DONE', pool: 'local-omlx' },
      ],
    });
    const read = parseQueueV1Document(doc);
    expect(read.jobs).toBe(4);
    expect(read.live.get('devin')).toBe(1);
    expect(read.live.get('codex-personal')).toBe(1);
    expect(read.ready.get('devin')).toBe(1);
    expect(read.live.has('local-omlx')).toBe(false); // DONE is terminal, not live
    expect(read.jobPool.get('RQ-3')).toBe('codex-personal');
    expect([...read.jobPool.entries()]).toEqual([['RQ-1', 'devin'], ['RQ-2', 'devin'], ['RQ-3', 'codex-personal'], ['RQ-4', 'local-omlx']]);
    expect(read.rows).toHaveLength(4);
  });

  it('malformed jobs still reject — the row projection adds no leniency', () => {
    expect(() => parseQueueV1Document('{"schema":"other","jobs":[]}')).toThrow();
    expect(() => parseQueueV1Document('{"schema":"queue.v1","jobs":[{"id":"RQ-1","status":"READY","pool":"bad pool!"}]}')).toThrow();
    expect(() => parseQueueV1Document('{"schema":"queue.v1","jobs":[{"id":"RQ-1","status":"READY"}]}')).toThrow();
    expect(() => parseQueueV1Document('{"schema":"queue.v1","jobs":[{"id":"RQ-1","status":7,"pool":"devin"}]}')).toThrow();
    expect(() => parseQueueV1Document('not json')).toThrow();
  });
});
