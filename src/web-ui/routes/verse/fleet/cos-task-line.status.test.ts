import { describe, expect, it } from 'vitest';
import { cosTaskLine, type CosStatus } from './cos-task-client.js';

const draft = { text: 'reply', digest: 'd' };
const line = (jobStatus: string, extra: Partial<Pick<CosStatus, 'draft' | 'delivery'>> = {}) =>
  cosTaskLine({ jobStatus, draft: null, delivery: null, ...extra });

describe('cosTaskLine job status mapping', () => {
  const rows: Array<[string[], string]> = [
    [['READY', 'ready', 'queued', 'QUEUED'], 'Queued · waiting for a worker'],
    [['CLAIMED', 'claimed', 'running', 'RUNNING'], 'A worker is on it'],
    [['BLOCKED', 'blocked'], 'The worker could not answer · retry with phm queue replay --failed'],
    [['DONE', 'done'], 'Done'],
    [['HOLD', 'hold'], 'On hold'],
    [['RETIRED', 'retired', 'DROPPED', 'dropped'], 'Closed without a reply'],
    [['PR-OPEN', 'PROPOSED', 'SPLIT-PARENT', 'FIXUP', 'LAND', 'weird', ''], 'Status unknown'],
  ];
  for (const [statuses, expected] of rows) {
    for (const status of statuses) {
      it(`${JSON.stringify(status)} -> ${expected}`, () => expect(line(status)).toBe(expected));
    }
  }

  it('a draft beats BLOCKED and DONE', () => {
    expect(line('BLOCKED', { draft })).toBe('Drafted · waiting for your approval');
    expect(line('DONE', { draft })).toBe('Drafted · waiting for your approval');
  });

  it("delivery 'sent' beats everything", () => {
    for (const status of ['BLOCKED', 'READY', 'DONE', 'weird']) {
      expect(line(status, { draft, delivery: 'sent' })).toBe('Sent');
    }
  });

  it('keeps the other delivery states ahead of the job status', () => {
    expect(line('BLOCKED', { delivery: 'uncertain' })).toMatch(/^Delivery uncertain/);
    expect(line('READY', { delivery: 'sending' })).toBe('Sending the approved reply…');
  });

  it('null status is still checking', () => expect(cosTaskLine(null)).toBe('Checking the task…'));
});
