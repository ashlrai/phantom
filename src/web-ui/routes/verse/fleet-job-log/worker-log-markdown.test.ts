import { expect, it } from 'vitest';
import type { FleetJobDetailV1 } from './worker-log-model.js';
import { workerLogMarkdown } from './worker-log-markdown.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const detail: FleetJobDetailV1 = {
  schema: 'fleet.job.v1', lane: 'codex', tier: 'mid', model: 'example-model', state: 'running',
  launchedAt: '2026-10-31T10:58:00Z', publish: { prUrl: 'https://github.com/example/repo/pull/12' },
  log: { source: 'live', tail: Array.from({ length: 65 }, (_, i) => `line ${i + 1}`), truncated: false },
};

it('formats the job metadata and keeps only the last requested log lines', () => {
  const result = workerLogMarkdown('RQ-FAKE', detail, now, { maxLines: 3 });
  expect(result).toBe('### RQ-FAKE\n- Lane: codex\n- Tier: mid\n- Model: example-model\n- State: running\n- Age: 1 hr 2 min\n- PR: https://github.com/example/repo/pull/12\n\n```text\nline 63\nline 64\nline 65\n```\n(log truncated)');
  const defaultLines = workerLogMarkdown('RQ-FAKE', detail, now).split('```text\n')[1]!.split('\n```')[0]!.split('\n');
  expect(defaultLines).toHaveLength(60);
  expect(defaultLines[0]).toBe('line 6');
  expect(defaultLines[59]).toBe('line 65');
});

it('removes terminal escapes and control bytes, and omits unsafe URLs', () => {
  const result = workerLogMarkdown('RQ-FAKE', { ...detail, publish: { prUrl: 'javascript:alert(1)' }, log: {
    tail: ['\u001b[31mred\u001b[0m\u0000\tend\r', '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007'], truncated: true,
  } }, now);
  expect(result).toContain('```text\nred\tend\nlink\n```\n(log truncated)');
  expect(result).not.toContain('PR:');
});

it('omits unknown fields and reports a missing log', () => {
  expect(workerLogMarkdown('RQ-FAKE', { schema: 'fleet.job.v1', state: 'unknown', log: { source: 'missing' } }, now)).toBe('### RQ-FAKE\n\nNo log yet');
  expect(workerLogMarkdown('RQ-FAKE', { schema: 'fleet.job.v1' }, now)).toBe('### RQ-FAKE\n\nNo log yet');
});

it('keeps embedded fences inside the log and handles zero lines requested', () => {
  const withFence = { ...detail, log: { tail: ['```', 'last'] } };
  expect(workerLogMarkdown('RQ-FAKE', withFence, now)).toContain('````text\n```\nlast\n````');
  expect(workerLogMarkdown('RQ-FAKE', withFence, now, { maxLines: 0 })).toContain('```text\n```\n(log truncated)');
});
