import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { draftIdeas, IdeasDraftError, ideasDraftId, type IdeasDraftDeps } from '../src/core/web/ideas-draft-route.js';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'ideas-draft-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

const items = Array.from({ length: 10 }, (_, i) => ({
  id: `idea-${i}`, repo: '/work/phantom', source: 'issue', title: `Fix thing ${i}`,
  detail: `Why ${i}: src/core/thing${i}.ts is wrong`, score: 90 - i,
}));
const deps = (extra: IdeasDraftDeps = {}): IdeasDraftDeps => ({
  runsDir,
  backlog: () => ({ items } as never),
  readQueuedClaims: async () => ({ sourceState: 'missing', claims: new Map() }),
  ...extra,
});
const dropped = () => readdir(join(runsDir, 'leader', 'drop', 'claude')).catch(() => []);

describe('draftIdeas', () => {
  it('writes one draft for a single idea', async () => {
    const result = await draftIdeas({ ideaIds: ['idea-1'] }, deps());
    expect(result).toMatchObject({ written: true, existing: false, collisions: [] });
    expect(await dropped()).toEqual([`RQ-PHX-${result.draftId}.md`]);
    const text = await readFile(join(runsDir, 'leader', 'drop', 'claude', `RQ-PHX-${result.draftId}.md`), 'utf8');
    expect(text.split('\n')[0]).toBe('#job repo=phantom lane=claude tier=work');
    expect(text).toContain('Fix thing 1');
    expect(text).toContain('idea idea-1');
  });

  it('returns the same draft when the same set is sent twice, in any order', async () => {
    const first = await draftIdeas({ ideaIds: ['idea-1', 'idea-2'] }, deps());
    const second = await draftIdeas({ ideaIds: ['idea-2', 'idea-1', 'idea-2'] }, deps());
    expect(second.draftId).toBe(first.draftId);
    expect(second).toMatchObject({ written: false, existing: true });
    expect(await dropped()).toHaveLength(1);
  });

  it('writes one draft naming all three ideas of a batch', async () => {
    const result = await draftIdeas({ ideaIds: ['idea-0', 'idea-1', 'idea-2'] }, deps());
    expect(await dropped()).toHaveLength(1);
    const text = await readFile(join(runsDir, 'leader', 'drop', 'claude', `RQ-PHX-${result.draftId}.md`), 'utf8');
    for (const i of [0, 1, 2]) expect(text).toContain(`Fix thing ${i}`);
    expect(ideasDraftId(['idea-0', 'idea-1'])).not.toBe(ideasDraftId(['idea-0', 'idea-2']));
  });

  it('refuses 9 ids, none, and ids that are not in the backlog', async () => {
    const nine = items.slice(0, 9).map(i => i.id);
    await expect(draftIdeas({ ideaIds: nine }, deps())).rejects.toMatchObject({ status: 400 });
    await expect(draftIdeas({ ideaIds: [] }, deps())).rejects.toBeInstanceOf(IdeasDraftError);
    await expect(draftIdeas({ ideaIds: ['nope'] }, deps())).rejects.toMatchObject({ status: 404 });
    expect(await dropped()).toEqual([]);
  });

  it('passes collisions through and holds the write until they are confirmed', async () => {
    const claims = new Map([['src/core/thing1.ts', ['RQ-PHX-OTHER']]]);
    const withClaims = deps({ readQueuedClaims: async () => ({ sourceState: 'healthy', claims }) });
    const held = await draftIdeas({ ideaIds: ['idea-1'] }, withClaims);
    expect(held.collisions).toEqual([{ path: 'src/core/thing1.ts', draft: `RQ-PHX-${held.draftId}.md`, queued: ['RQ-PHX-OTHER'] }]);
    expect(held.written).toBe(false);
    expect(await dropped()).toEqual([]);
    const confirmed = await draftIdeas({ ideaIds: ['idea-1'], confirmCollisions: true }, withClaims);
    expect(confirmed).toMatchObject({ written: true, draftId: held.draftId });
    expect(confirmed.collisions).toHaveLength(1);
  });

  it('refuses a draft whose text names a protected path', async () => {
    const bad = deps({ backlog: () => ({ items: [{ ...items[0]!, detail: 'edit .github/workflows/ci.yml' }] } as never) });
    await expect(draftIdeas({ ideaIds: ['idea-0'] }, bad)).rejects.toMatchObject({ status: 422 });
  });
});
