/**
 * RQ-PHX-CONTEXTPACKCOVER181S — preserves the unique regression coverage of
 * Phantom PR #2910 (test/context-pack.test.ts @ 7e6e482d5d724aada14f77730e722672b2866b03)
 * on current master. Cases already covered by
 * test/context-pack-original-4304-preservation-10srn2.test.ts and
 * test/fleet-context-pack-reconcile-09snu1.test.ts (unrelated-job exclusion,
 * thread-ancestry inclusion in `threads`, password-key redaction, single-build
 * log metadata, bus-missing failure) are mapped, not duplicated here. The old
 * cmdCtxpack entry point is exercised through its current replacement
 * cmdFleetContextPack. Sensitive-key fixtures use plainly fake ordinary
 * phrases: the source credential shape is deliberately not reproduced, and
 * these assertions do not claim free-text credential-detector coverage.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { buildContextPack, compactContext, packTokens } from '../src/core/fleet/context-pack.js';
import { cmdFleetContextPack } from '../src/cli/fleet-context-pack.js';
import { learnOutcomes } from '../src/core/routing/outcome-learning.js';

let root: string;
const now = 1793577600000;
// One well-formed LAUNCH and one well-formed OUTCOME line so the shared log
// stays a valid outcome store (CTXPACK accounting entries must not corrupt it).
const LOG = '2026-11-01 00:00:00 MERGED job=old\n' +
  '2026-11-01 23:50:00 LAUNCH new phantom claude opus code\n' +
  '2026-11-02 00:00:00 OUTCOME new merged usage=0.2\n';
const logPath = () => join(root, 'queue', 'dispatch-events.log');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ctxpack-181s-'));
  await mkdir(join(root, 'queue'));
  await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({
    last_tick: new Date(now).toISOString(), paused: false, mem_free_pct: 50,
    lanes: { claude: { running: 1, target: 2, queued: 0, held: false, held_reason: null } },
  }));
  await writeFile(logPath(), LOG);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const options = () => ({ job: 'JOB-1', lane: 'claude', root: join(root, 'bus'), runsDir: root, home: root, now: () => now });
const post = (id: string, body: object): void => {
  expect(appendBusInbox({ id, from: 'core', to: 'claude', priority: 'P0', ttl: 60000, body }, options()).status).toBe('posted');
};
const blockerRows = async (): Promise<unknown[]> => {
  const pack = JSON.parse(await buildContextPack(options())) as { sections: { name: string; rows: unknown[] }[] };
  return pack.sections.find(section => section.name === 'blockers')!.rows;
};

describe('context pack preserved from PR #2910', () => {
  it('emits byte-identical JSON across clock changes and logs usage to the outcome store', async () => {
    post('thread', { job: 'JOB-1', text: 'ordinary job thread text' });
    const first = await buildContextPack(options());
    const second = await buildContextPack({ ...options(), now: () => now + 1000 });
    expect(second).toBe(first);
    expect(first).toContain('ordinary job thread text');
    // Newest merge evidence is listed before older merge lines.
    expect(first.indexOf('OUTCOME new')).toBeLessThan(first.indexOf('job=old'));
    const log = await readFile(logPath(), 'utf8');
    expect(log.match(/CTXPACK /g)).toHaveLength(2);
    expect(log).toContain(`pack_tokens=${packTokens(first)}`);
    expect(learnOutcomes(log).malformed).toBe(0);
  });

  it('never exceeds the cap for multibyte text and trims lowest priority sections first', () => {
    const json = compactContext('job', 'lane', [
      { name: 'blockers', rows: ['keep'] },
      { name: 'threads', rows: ['世界'.repeat(10000)] },
    ], 256);
    expect(packTokens(json)).toBeLessThanOrEqual(256);
    expect(json).toContain('keep');
    expect(json).not.toContain('世界');
  });

  it('redacts sensitive keys in every section before budgeting', () => {
    const phrase = 'plain substitute phrase';
    const json = compactContext('job', 'lane', [
      { name: 'threads', rows: [{ text: 'ordinary note', password: phrase, token: phrase, secret: phrase, apiKey: phrase }] },
    ], 2000);
    expect(json).not.toContain(phrase);
    expect(json.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it('rejects bad budgets, identifiers and missing sources with corrective instructions', async () => {
    await expect(buildContextPack({ ...options(), maxTokens: 2001 })).rejects.toThrow('--max-tokens 256..2000');
    await expect(buildContextPack({ ...options(), merges: 101 })).rejects.toThrow('--merges 0..100');
    await expect(buildContextPack({ ...options(), job: 'bad id' })).rejects.toThrow('safe job/lane IDs');
    await rm(logPath());
    await expect(buildContextPack(options())).rejects.toThrow('Start the fleet');
  });

  it('keeps CLI JSON byte-identical and bounded across fixture runs', async () => {
    // Current production requires readable bus storage before any pack build,
    // so the fixture seeds one ordinary thread (newer behavior, preserved).
    post('thread', { job: 'JOB-1', text: 'ordinary job thread text' });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const args = ['build', '--job', 'JOB-1', '--lane', 'claude', '--max-tokens', '256', '--json'];
      expect(await cmdFleetContextPack(args, options())).toBe(0);
      expect(await cmdFleetContextPack(args, options())).toBe(0);
      expect(output.mock.calls[0]).toEqual(output.mock.calls[1]);
      expect(packTokens(output.mock.calls[0]![0])).toBeLessThanOrEqual(256);
      expect(() => JSON.parse(output.mock.calls[0]![0])).not.toThrow();
      // Without --json the CLI still emits the same bounded JSON document.
      expect(await cmdFleetContextPack(args.slice(0, -1), options())).toBe(0);
      expect(packTokens(output.mock.calls[2]![0])).toBeLessThanOrEqual(256);
    } finally { output.mockRestore(); }
  });

  it('includes a parent forum thread when a reply references the job and clears resolved blockers', async () => {
    post('parent', { text: 'forum parent' });
    post('reply', { inReplyTo: 'parent', job: 'JOB-1', status: 'blocked' });
    expect(await buildContextPack(options())).toContain('forum parent');
    expect(await blockerRows()).toHaveLength(1);
    post('resolved', { inReplyTo: 'reply', status: 'resolved' });
    expect(await blockerRows()).toHaveLength(0);
  });
});
