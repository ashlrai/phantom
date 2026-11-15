import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { awaitEmailOutboxBatch } from '../src/core/comms/email-outbox-batch-await.js';
import type { EmailOutboxEntry, EmailOutboxListing } from '../src/core/comms/email-outbox.js';

const names = ['sent.reply.eml', 'draft.reply.eml', 'stuck.reply.eml', 'wait.reply.eml'];
const listing = (entries: EmailOutboxEntry[]): EmailOutboxListing => ({
  dir: 'fake', counts: { queued: 0, sent: 0, stuck: 0, drafted: 0 }, entries,
});
const signal = () => new AbortController().signal;

describe('batch current email evidence', () => {
  it('discards all previous states and reasons when a later read fails', async () => {
    let reads = 0;
    let now = 0;
    const result = await awaitEmailOutboxBatch({
      dir: 'fake', names, timeoutMs: 100, pollMs: 10, signal: signal(), now: () => now,
      sleep: async (ms) => { now += ms; },
      read: () => {
        if (reads++ > 0) throw new Error('unavailable');
        return listing([
          { name: names[0]!, state: 'sent' }, { name: names[1]!, state: 'drafted' },
          { name: names[2]!, state: 'stuck', reason: 'unreadable' }, { name: names[3]!, state: 'queued' },
        ]);
      },
    });
    expect(reads).toBe(2);
    expect(result).toEqual({ rows: names.map(name => ({ name, state: 'missing' })), timedOut: false, cancelled: false, sourceFailure: true });
  });

  it('waits for missing entries and preserves successful terminal and ambiguous results', async () => {
    let reads = 0;
    let now = 0;
    const result = await awaitEmailOutboxBatch({
      dir: 'fake', names: names.slice(0, 3), timeoutMs: 100, pollMs: 10, signal: signal(), now: () => now,
      sleep: async (ms) => { now += ms; },
      read: () => listing(++reads === 1 ? [{ name: names[0]!, state: 'sent' }] : [
        { name: names[0]!, state: 'sent' }, { name: names[1]!, state: 'drafted' },
        { name: names[2]!, state: 'sent' }, { name: names[2]!, state: 'queued' },
      ]),
    });
    expect(reads).toBe(2);
    expect(result).toEqual({ rows: [
      { name: names[0], state: 'sent', reason: undefined },
      { name: names[1], state: 'drafted', reason: undefined },
      { name: names[2], state: 'stuck', reason: 'malformed' },
    ], timedOut: false, cancelled: false, sourceFailure: false });
  });

  it('clears a real observation when the outbox becomes unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'email-batch-evidence-'));
    try {
      const dir = join(root, 'outbox');
      mkdirSync(join(dir, 'sent'), { recursive: true });
      writeFileSync(join(dir, 'sent', names[0]!), 'fake');
      let now = 0;
      const result = await awaitEmailOutboxBatch({
        dir, names: [names[0]!, names[3]!], timeoutMs: 100, pollMs: 10, signal: signal(), now: () => now,
        sleep: async (ms) => { now += ms; renameSync(dir, join(root, 'unavailable')); },
      });
      expect(result).toEqual({ rows: [names[0], names[3]].map(name => ({ name, state: 'missing' })), timedOut: false, cancelled: false, sourceFailure: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
