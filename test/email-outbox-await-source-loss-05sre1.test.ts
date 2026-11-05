import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitEmailOutbox, type AwaitOptions } from '../src/core/comms/email-outbox-await.js';
import type { EmailOutboxListing } from '../src/core/comms/email-outbox.js';

const NAME = 'artifact.reply.eml';
const BYTES = 'To: fake@example.test\nSubject: private-subject\n\nprivate-body';
const dirs: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-await-loss-'));
  dirs.push(dir);
  return dir;
}

function options(dir: string, extra: Partial<AwaitOptions> = {}): AwaitOptions {
  return { dir, name: NAME, timeoutMs: 300, pollMs: 100, signal: new AbortController().signal, ...extra };
}

afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('awaitEmailOutbox source loss (RQ-PHX-EMAILWAITFAILURE05SRE1)', () => {
  it.each([
    ['removed', (dir: string) => rmSync(dir, { recursive: true, force: true })],
    ['replaced', (dir: string) => { rmSync(dir, { recursive: true, force: true }); writeFileSync(dir, 'x'); }],
  ])('reports source-failure with no state when the outbox is %s between polls', async (_label, mutate) => {
    const dir = fixture();
    writeFileSync(join(dir, NAME), BYTES);
    let now = 0;
    let sleeps = 0;
    const result = await awaitEmailOutbox(options(dir, {
      now: () => now,
      sleep: async (ms) => { now += ms; sleeps += 1; mutate(dir); },
    }));
    // One sleep proves the first poll observed the queued artifact, then the
    // next observation failed — the regression case for stale 'queued'.
    expect(sleeps).toBe(1);
    expect(result).toEqual({ name: NAME, reason: 'source-failure', timedOut: false, cancelled: false });
    expect(result.state).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/queued|drafted|sent/);
  });

  it('clears the queued state on an injected read failure without leaking exception text', async () => {
    const dir = fixture();
    const marker = 'INJECTED-FAULT-MARKER-05sre1-internal-detail';
    let calls = 0;
    const read = vi.fn((d: string): EmailOutboxListing => {
      calls += 1;
      if (calls === 1) {
        return { dir: d, counts: { queued: 1, sent: 0, drafted: 0, stuck: 0 }, entries: [{ name: NAME, state: 'queued' }] };
      }
      throw new Error(`read exploded: ${marker}`);
    });
    let now = 0;
    const result = await awaitEmailOutbox(options(dir, {
      read,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ name: NAME, reason: 'source-failure', timedOut: false, cancelled: false });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain('read exploded');
    expect(serialized).not.toContain('queued');
  });

  it.each(['drafted', 'sent'] as const)('still completes queued -> %s normally', async (state) => {
    const dir = fixture();
    writeFileSync(join(dir, NAME), BYTES);
    mkdirSync(join(dir, state));
    let now = 0;
    const result = await awaitEmailOutbox(options(dir, {
      now: () => now,
      sleep: async (ms) => { now += ms; renameSync(join(dir, NAME), join(dir, state, NAME)); },
    }));
    expect(result).toEqual({ name: NAME, state, timedOut: false, cancelled: false });
    expect(result.reason).toBeUndefined();
    expect(readFileSync(join(dir, state, NAME), 'utf8')).toBe(BYTES);
  });

  it('still reports the last observed state on timeout', async () => {
    const dir = fixture();
    writeFileSync(join(dir, NAME), BYTES);
    let now = 0;
    const result = await awaitEmailOutbox(options(dir, {
      now: () => now,
      sleep: async (ms) => { now += ms; },
    }));
    expect(result).toEqual({ name: NAME, state: 'queued', timedOut: true, cancelled: false });
  });

  it('still reports the last observed state on cancellation', async () => {
    const dir = fixture();
    writeFileSync(join(dir, NAME), BYTES);
    const controller = new AbortController();
    let now = 0;
    const result = await awaitEmailOutbox(options(dir, {
      signal: controller.signal,
      now: () => now,
      sleep: async (ms) => { now += ms; controller.abort(); },
    }));
    expect(result).toEqual({ name: NAME, state: 'queued', timedOut: false, cancelled: true });
  });
});
