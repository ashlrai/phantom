import { expect, it } from 'vitest';
import { readMerges } from './fleet-merges-model.js';
import { mergesMarkdown } from './merges-markdown.js';

it('formats merges and waiting jobs without unsafe URLs or title text', () => {
  const now = Date.parse('2026-10-31T11:05:00Z');
  const data = readMerges({ mergesLastHour: { count: 2, items: [
    { repo: 'org/repo', number: 1, title: 'RQ-ONE private text' },
    { repo: 'org/repo', number: 2, title: 'RQ-TWO' },
  ] }, publishesLastHour: [
    { job: 'RQ-TWO', lane: 'codex-personal', at: '2026-10-31T10:53:00Z', url: 'https://github.com/org/repo/pull/2' },
    { job: 'RQ-WAIT', lane: 'x', at: '2026-10-31T10:50:00Z' },
  ] });
  data.merged[1]!.href = 'javascript:alert(1)';
  expect(mergesMarkdown(data, now)).toBe('2 merged in the last hour · 1 publishes waiting · 07:05 ET\n- RQ-TWO · codex-personal · 12m ago · https://github.com/org/repo/pull/2\n- RQ-ONE · — · —\nWaiting: RQ-WAIT');
  expect(mergesMarkdown(readMerges({}), now)).toBe('');
});
