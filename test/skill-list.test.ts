import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatSkillList, listSkills, SKILL_LIST_TEXT_CAP } from '../src/core/fleet/skill-list.js';
import { cmdSkills } from '../src/cli/skills.js';
import { readSkillCardCorpus } from '../src/core/fleet/skill-records.js';
import type { SkillCard } from '../src/core/types.js';

vi.mock('../src/core/fleet/skill-records.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/skill-records.js')>();
  return { ...actual, readSkillCardCorpus: vi.fn() };
});

const card = (skillId: string, extra: Partial<SkillCard> = {}): SkillCard => ({
  schemaVersion: 1, skillId, revision: 1, ts: '2026-01-01T00:00:00.000Z', name: skillId, summary: 'does a thing',
  status: 'verified', source: 'verified-proposal', ...extra,
});
let cards: SkillCard[];
let invalidRows: number;
beforeEach(() => {
  cards = [];
  invalidRows = 0;
  vi.mocked(readSkillCardCorpus).mockImplementation(() => ({ cards, sourceState: 'healthy', sourcePresent: true,
    filesScanned: 1, unreadableFiles: 0, invalidRows, bytesScanned: 0, limitExceeded: false }));
});

async function run(args: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
  try { return { code: await cmdSkills(args), out }; } finally { spy.mockRestore(); }
}

describe('listSkills', () => {
  it('keeps only the newest revision per skill, newest first', () => {
    cards = [card('a', { revision: 1, name: 'old' }), card('a', { revision: 2, name: 'new', ts: '2026-02-01T00:00:00.000Z' }),
      card('b', { ts: '2026-03-01T00:00:00.000Z' })];
    const report = listSkills();
    expect(report).toMatchObject({ total: 2, matched: 2, returned: 2, corpus: 'healthy', invalidRows: 0 });
    expect(report.skills.map((s) => [s.skillId, s.name])).toEqual([['b', 'b'], ['a', 'new']]);
  });

  it('reports unknown instead of guessing and scrubs and caps text', () => {
    cards = [card('a', { summary: `token=ghp_${'a'.repeat(36)} ${'x'.repeat(500)}` })];
    const [s] = listSkills().skills;
    expect(s).toMatchObject({ evidenceCount: 'unknown', proposalId: 'unknown', attestationPresent: false, verificationPassed: false });
    expect(s!.summary).not.toContain('ghp_');
    expect(s!.summary.length).toBeLessThanOrEqual(SKILL_LIST_TEXT_CAP);
  });

  it('filters by status and limits, counting before the limit', () => {
    cards = [card('a'), card('b', { status: 'revoked' }), card('c')];
    expect(listSkills({ status: 'verified', limit: 1 })).toMatchObject({ matched: 2, returned: 1, total: 3 });
  });

  it('degrades to an empty unknown report when the corpus read throws', () => {
    vi.mocked(readSkillCardCorpus).mockImplementation(() => { throw new Error('boom'); });
    expect(listSkills()).toMatchObject({ total: 0, corpus: 'degraded', invalidRows: 'unknown', skills: [] });
    expect(formatSkillList(listSkills())).toContain('No skills yet');
  });
});

describe('skills list CLI', () => {
  it('prints parseable JSON and exits 0, also when empty', async () => {
    const empty = await run(['list', '--json']);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.out)).toMatchObject({ schemaVersion: 1, total: 0, skills: [] });
    cards = [card('a')];
    expect(JSON.parse((await run(['list', '--json', '--status', 'verified', '--limit', '5'])).out).skills).toHaveLength(1);
  });

  it('prints plain text without --json', async () => {
    cards = [card('a')];
    expect((await run(['list'])).out).toContain('verified');
  });

  it.each([
    [['list', '--bogus']], [['list', '--status', 'nope']], [['list', '--limit', '0']], [['list', '--limit', '201']],
    [['list', '--limit']], [['list', '--json', '--json']], [['list', 'extra']], [['list', '--help']],
  ])('refuses bad usage %j with exit 2', async (args) => {
    const { code } = await run(args);
    expect(code).toBe(2);
  });
});
