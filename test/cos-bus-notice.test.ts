/** cos bus notice: envelope shape, privacy, dedupe, failure isolation, CLI exit code. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CosWorkResult } from '../src/core/cos/worker.js';
import { cosBusNotice, postCosBusNotice } from '../src/core/cos/bus-notice.js';
import { validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const worker = vi.hoisted(() => ({ result: { outcome: 'idle' } as unknown }));
vi.mock('../src/core/cos/worker.js', () => ({ runCosWorkOnce: async () => worker.result }));

const JOB = `cos-${'a'.repeat(32)}`;
const drafted: CosWorkResult = { outcome: 'drafted', id: JOB, provider: 'fake' };
const blocked: CosWorkResult = { outcome: 'blocked', id: JOB, reason: 'no provider available' };

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cos-bus-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('cosBusNotice', () => {
  it('builds a valid P1 envelope for drafted', () => {
    const env = cosBusNotice(drafted, 0)!;
    expect(validateBusEnvelope(env).ok).toBe(true);
    expect(env).toMatchObject({ from: 'cos-worker', to: 'mason', priority: 'P1', ttl: 86_400_000,
      body: { kind: 'cos-drafted', id: JOB, provider: 'fake' } });
  });
  it('builds a valid P2 envelope for blocked', () => {
    const env = cosBusNotice(blocked, 0)!;
    expect(validateBusEnvelope(env).ok).toBe(true);
    expect(env).toMatchObject({ priority: 'P2', body: { kind: 'cos-blocked', id: JOB, reason: 'no provider available' } });
    expect(env.id).not.toBe(cosBusNotice(drafted, 0)!.id);
  });
  it('returns null for idle and paused', () => {
    expect(cosBusNotice({ outcome: 'idle' }, 0)).toBeNull();
    expect(cosBusNotice({ outcome: 'paused' }, 0)).toBeNull();
  });
  it('never carries draft, request, sender or thread text', () => {
    const leaky = { ...drafted, draft: 'SECRET-DRAFT', scope: 'SECRET-SCOPE', senderId: 'SECRET-SENDER', threadId: 'SECRET-THREAD' };
    const json = JSON.stringify(cosBusNotice(leaky as CosWorkResult, 0));
    for (const s of ['SECRET-DRAFT', 'SECRET-SCOPE', 'SECRET-SENDER', 'SECRET-THREAD']) expect(json).not.toContain(s);
  });
});

describe('postCosBusNotice', () => {
  it('posts once and reports a repeat as duplicate', () => {
    expect(postCosBusNotice(drafted, { root })).toBe('posted');
    expect(postCosBusNotice(drafted, { root })).toBe('duplicate');
    const page = listBusInboxAfter(0, 10, { root });
    expect(page.status === 'ok' && page.messages).toHaveLength(1);
  });
  it('skips idle and paused', () => {
    expect(postCosBusNotice({ outcome: 'idle' }, { root })).toBe('skipped');
    expect(postCosBusNotice({ outcome: 'paused' }, { root })).toBe('skipped');
  });
  it('returns failed for an unwritable root without throwing', async () => {
    const file = join(root, 'file');
    await writeFile(file, 'x');
    expect(postCosBusNotice(blocked, { root: join(file, 'nested') })).toBe('failed');
  });
});

describe('cmdFleetCosWork bus post', () => {
  it('still exits 1 for blocked and keeps the stdout line', async () => {
    vi.stubEnv('HOME', root);
    vi.stubEnv('ASHLR_HOME', join(root, 'ashlr-home'));
    worker.result = blocked;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { cmdFleetCosWork } = await import('../src/cli/fleet-cos-work.js');
    expect(await cmdFleetCosWork([])).toBe(1);
    expect(log).toHaveBeenCalledWith(`blocked ${JOB}: no provider available`);
    vi.unstubAllEnvs();
  });
});
