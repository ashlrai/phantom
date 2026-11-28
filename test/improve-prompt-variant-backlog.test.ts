import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promptVariantBacklogItems } from '../src/core/improve/prompt-variant-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = await mkdtemp(join(tmpdir(), 'improve-promptvar-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const ashlrDir = (): string => join(home, '.ashlr');
const registryPath = (): string => join(ashlrDir(), 'eval', 'prompts', 'promotions.json');

const metric = (value: number | null, n: number, ci95: [number, number] | null = null) => ({ value, ci95, n });

const promotedRecord = (over: Record<string, unknown> = {}) => ({
  classId: 'docs',
  experimentId: 'prompt-ab-2026-10-28',
  variant: 'prompt:adaptive',
  control: 'prompt:plain',
  before: metric(0.3333333333333333, 30, [0.1923, 0.5122]),
  after: metric(0.7777777777777778, 27, [0.5924, 0.8939]),
  liftPoints: 0.4444444444444445,
  costPerMergedPrBefore: 1.7,
  costPerMergedPrAfter: 1.1,
  decidedAt: '2026-10-28T15:27:15.459Z',
  datasetSha256: 'de1488606aba8bfa53ad3be1047523c60b98e5ab1b62fee294d27512a41dbd55',
  ...over,
});

const registry = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  generatedAt: '2026-10-28T15:27:15.459Z',
  experimentId: 'prompt-ab-2026-10-28',
  dataset: { id: 'prompt-ab-2026-10-28', sha256: 'de1488606aba8bfa53ad3be1047523c60b98e5ab1b62fee294d27512a41dbd55', jobs: 65 },
  classes: ['docs', 'tests', 'secrets'],
  promoted: [promotedRecord()],
  held: [
    { classId: 'tests', variant: 'prompt:adaptive', verdict: 'not-significant' },
    { classId: 'secrets', variant: 'prompt:adaptive', verdict: 'insufficient-data' },
  ],
  ...over,
});

const writeRegistry = async (body: unknown): Promise<void> => {
  await mkdir(join(ashlrDir(), 'eval', 'prompts'), { recursive: true });
  await writeFile(registryPath(), typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
};

const opts = () => ({ repo: 'ashlrai/phantom', now: new Date(NOW_MS), rootDir: ashlrDir() });

describe('promptVariantBacklogItems', () => {
  it('emits one aggregate item quoting every promoted class with its gate evidence', async () => {
    await writeRegistry(registry({
      promoted: [
        promotedRecord(),
        promotedRecord({
          classId: 'tests',
          variant: 'prompt:adaptive',
          before: metric(0.615, 26),
          after: metric(0.667, 24),
          liftPoints: 0.052,
          decidedAt: '2026-10-29T09:00:00.000Z',
          experimentId: 'prompt-ab-2026-10-29',
        }),
      ],
    }));
    const items = await promptVariantBacklogItems(opts());
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^promptvariant-[0-9a-f]{12}$/);
    expect(item.priority).toBe(2);
    expect(item.area).toBe('prompt-variants');
    expect(item.repo).toBe('ashlrai/phantom');
    expect(item.doneWhen).toBeUndefined();
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.title).toContain('docs');
    expect(item.title).toContain('tests');
    expect(item.prompt).toContain('assignPromptVariant');
    expect(item.prompt).toContain('prompt:adaptive');
    expect(item.prompt).toContain('prompt:plain');
    expect(item.prompt).toContain('77.8%');
    expect(item.prompt).toContain('33.3%');
    expect(item.prompt).toContain('+44.4pts');
    expect(item.prompt).toContain('n 30→27');
    expect(item.prompt).toContain('2026-10-28T15:27:15.459Z');
    expect(item.prompt).toContain('prompt-ab-2026-10-28');
    expect(item.prompt).toContain('eval/prompts/promotions.json');
    expect(item.prompt).toContain('2 held classes');
    expect(item.prompt).toContain('no-change');
  });

  it('stays quiet on an absent, malformed or held-only registry', async () => {
    expect(await promptVariantBacklogItems(opts())).toEqual([]);
    await writeRegistry('{not json');
    expect(await promptVariantBacklogItems(opts())).toEqual([]);
    await writeRegistry(registry({ schemaVersion: 2 }));
    expect(await promptVariantBacklogItems(opts())).toEqual([]);
    await writeRegistry(registry({ promoted: [] }));
    expect(await promptVariantBacklogItems(opts())).toEqual([]);
    // held entries alone are the gate working, never evidence.
    await writeRegistry(registry({ promoted: [], held: [{ classId: 'docs', variant: 'prompt:adaptive', verdict: 'cost-regression' }] }));
    expect(await promptVariantBacklogItems(opts())).toEqual([]);
  });

  it('skips malformed promoted records, counts them and keeps the valid ones', async () => {
    await writeRegistry(registry({
      promoted: [
        promotedRecord(),
        { classId: 'broken' },
        promotedRecord({ classId: '', variant: 'prompt:adaptive' }),
        promotedRecord({ classId: 'tests', variant: 'prompt:adaptive', before: { value: 'high', ci95: null, n: 3 }, after: metric(0.5, 3), liftPoints: 0.1, decidedAt: '2026-10-29T00:00:00.000Z' }),
        promotedRecord({ classId: 'secrets', liftPoints: Number.NaN, decidedAt: '2026-10-29T00:00:00.000Z' }),
        promotedRecord({ classId: 'future', decidedAt: '2026-12-01T12:05:00.000Z' }),
      ],
    }));
    const items = await promptVariantBacklogItems(opts());
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('docs');
    expect(items[0]!.prompt).toContain('5 malformed');
    expect(items[0]!.prompt).not.toContain('future');
    expect(items[0]!.prompt).not.toContain('broken');
  });

  it('folds duplicate classIds to the newest decidedAt', async () => {
    await writeRegistry(registry({
      promoted: [
        promotedRecord({ variant: 'prompt:old', decidedAt: '2026-10-20T00:00:00.000Z', liftPoints: 0.1 }),
        promotedRecord({ variant: 'prompt:adaptive', decidedAt: '2026-10-28T15:27:15.459Z', liftPoints: 0.444 }),
      ],
    }));
    const items = await promptVariantBacklogItems(opts());
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('prompt:adaptive');
    expect(items[0]!.prompt).not.toContain('prompt:old');
    expect(items[0]!.prompt).toContain('1 malformed');
  });

  it('quotes a null recorded merge rate as unknown, never zero', async () => {
    await writeRegistry(registry({
      promoted: [promotedRecord({ before: metric(null, 0), after: metric(0.5, 4), liftPoints: 0.5 })],
    }));
    const items = await promptVariantBacklogItems(opts());
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('unknown→50.0%');
    expect(items[0]!.prompt).not.toContain('0.0%→50.0%');
  });

  it('emits only for the fleet repository', async () => {
    await writeRegistry(registry());
    expect(await promptVariantBacklogItems({ ...opts(), repo: 'ashlrai/other' })).toEqual([]);
    expect(await promptVariantBacklogItems({ ...opts(), repo: 'ashlrai/phantom-extra' })).toEqual([]);
    expect(await promptVariantBacklogItems({ ...opts(), repo: 'phantom' })).toHaveLength(1);
    expect(await promptVariantBacklogItems({ ...opts(), repo: 'AshlrAI/Phantom' })).toHaveLength(1);
    expect(await promptVariantBacklogItems({ ...opts(), repo: '' })).toEqual([]);
  });

  it('derives a stable id from the promoted class set and re-derives it on refresh', async () => {
    await writeRegistry(registry());
    const first = await promptVariantBacklogItems(opts());
    const second = await promptVariantBacklogItems(opts());
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // A changed promoted set is new evidence and earns a new id.
    await writeRegistry(registry({
      promoted: [promotedRecord(), promotedRecord({ classId: 'tests', variant: 'prompt:adaptive', decidedAt: '2026-10-29T00:00:00.000Z' })],
    }));
    const third = await promptVariantBacklogItems(opts());
    expect(third).toHaveLength(1);
    expect(third[0]!.id).not.toBe(first[0]!.id);
  });

  it('scrubs secrets out of quoted registry fields', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    await writeRegistry(registry({
      promoted: [promotedRecord({ classId: `docs-${token}`, variant: 'prompt:adaptive' })],
    }));
    const items = await promptVariantBacklogItems(opts());
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('appends the item through discovery and dedupes on refresh', async () => {
    await writeRegistry(registry());
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const mine = first.items.filter((i) => i.id.startsWith('promptvariant-'));
    expect(mine).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(mine)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('promptvariant-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('promptvariant-'))).toHaveLength(1);
  });
});
