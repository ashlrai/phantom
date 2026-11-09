import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContextPack, compactContext, packTokens } from '../src/core/fleet/context-pack.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { cmdCtxpack } from '../src/cli/ctxpack.js';
import { learnOutcomes } from '../src/core/routing/outcome-learning.js';

let root: string;
const now = 1793577600000;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ctxpack-'));
  await mkdir(join(root, 'queue'));
  await writeFile(join(root, 'queue/dispatch-events.log'), '2026-11-01 00:00:00 MERGED job=old\n2026-11-01 23:50:00 LAUNCH new phantom claude opus code\n2026-11-02 00:00:00 OUTCOME new merged usage=0.2\n');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const options = () => ({ job: 'JOB-1', lane: 'claude', root: join(root, 'bus'), runsDir: root, now: () => now });

describe('shared context pack', () => {
  it('emits byte-identical JSON across clock changes and logs usage to the outcome store', async () => {
    expect(appendBusInbox({ id: 'thread', from: 'core', to: 'claude', priority: 'P0', ttl: 60000,
      body: { job: 'JOB-1', text: 'Discuss this job' } }, options()).status).toBe('posted');
    const first = await buildContextPack(options());
    const second = await buildContextPack({ ...options(), now: () => now + 1000 });
    expect(second).toBe(first);
    expect(first).toContain('Discuss this job');
    expect(first.indexOf('OUTCOME new')).toBeLessThan(first.indexOf('job=old'));
    const log = await readFile(join(root, 'queue/dispatch-events.log'), 'utf8');
    expect(log.match(/CTXPACK /g)).toHaveLength(2);
    expect(log).toContain(`pack_tokens=${packTokens(first)}`);
    expect(learnOutcomes(log).malformed).toBe(0);
  });
  it('never exceeds the cap for multibyte text and removes lowest priority sections first', () => {
    const json = compactContext('job', 'lane', [{ name: 'blockers', rows: ['keep'] },
      { name: 'threads', rows: ['世界'.repeat(10000)] }], 256);
    expect(packTokens(json)).toBeLessThanOrEqual(256);
    expect(json).toContain('keep');
    expect(json).not.toContain('世界');
  });
  it('scrubs secret shapes in every section before budgeting', () => {
    const secret = 'ghp_' + 'a'.repeat(36);
    const json = compactContext('job', 'lane', [{ name: 'threads', rows: [{ text: secret, password: 'fixture-password', token: 'short secret' }] }], 2000);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('fixture-password');
    expect(json).not.toContain('short secret');
  });
  it('rejects bad budgets and missing sources with corrective instructions', async () => {
    await expect(buildContextPack({ ...options(), maxTokens: 2001 })).rejects.toThrow('--max-tokens 256..2000');
    await rm(join(root, 'queue/dispatch-events.log'));
    await expect(buildContextPack(options())).rejects.toThrow('Start the fleet');
  });
  it('keeps CLI JSON byte-identical and bounded across fixture runs', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const args = ['build', '--job', 'JOB-1', '--lane', 'claude', '--max-tokens', '256', '--json'];
      expect(await cmdCtxpack(args, options())).toBe(0);
      expect(await cmdCtxpack(args, options())).toBe(0);
      expect(output.mock.calls[0]).toEqual(output.mock.calls[1]);
      expect(packTokens(output.mock.calls[0]![0])).toBeLessThanOrEqual(256);
      expect(() => JSON.parse(output.mock.calls[0]![0])).not.toThrow();
      expect(await cmdCtxpack(args.slice(0, -1), options())).toBe(0);
      expect(packTokens(output.mock.calls[2]![0])).toBeLessThanOrEqual(256);
    } finally { output.mockRestore(); }
  });
  it('includes a parent forum thread when a reply references the job', async () => {
    appendBusInbox({ id: 'parent', from: 'core', to: 'claude', priority: 'P0', ttl: 60000, body: { text: 'forum parent' } }, options());
    appendBusInbox({ id: 'reply', from: 'core', to: 'claude', priority: 'P0', ttl: 60000, body: { inReplyTo: 'parent', job: 'JOB-1', status: 'blocked' } }, options());
    const pack = await buildContextPack(options());
    expect(pack).toContain('forum parent');
    expect(JSON.parse(pack).sections.find((section: { name: string }) => section.name === 'blockers').rows).toHaveLength(1);
    appendBusInbox({ id: 'resolved', from: 'core', to: 'claude', priority: 'P0', ttl: 60000, body: { inReplyTo: 'reply', status: 'resolved' } }, options());
    expect(JSON.parse(await buildContextPack(options())).sections.find((section: { name: string }) => section.name === 'blockers').rows).toHaveLength(0);
  });
  it('excludes unrelated job threads', async () => {
    appendBusInbox({ id: 'unrelated', from: 'core', to: 'claude', priority: 'P0', ttl: 60000,
      body: { job: 'JOB-10', text: 'unrelated text' } }, options());
    expect(await buildContextPack(options())).not.toContain('unrelated text');
  });
});
