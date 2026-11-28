import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyCommsReason,
  COMMS_RUN_MAX_ITEMS,
  COMMS_RUN_MIN_DAYS,
  COMMS_RUN_MIN_PASSES,
  commsRunBacklogItems,
  foldCommsRunCells,
  parseCommsRunPasses,
  type CommsReasonClass,
  type CommsRunPass,
} from '../src/core/improve/comms-run-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const SCHEMA = 'comms-agent.run.v1';
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const CUTOFF = NOW - 7 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

type SendSpec = [transport: string, status: string, reason: string];
const run = (at: string, sends: SendSpec[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    at,
    schema: SCHEMA,
    lane: 'comms',
    laneReason: 'test lane',
    triage: { kept: 1, archived: 0, drafted: 0, deleted: 0 },
    sends: sends.map(([transport, status, reason]) => ({ transport, recipient: 'handle-recipient-9', status, reason })),
    ...extra,
  });
const pass = (atMs: number, sends: CommsRunPass['sends']): CommsRunPass => ({ atMs, sends });
const outcome = (transport: string, status: 'refused' | 'drafted', reasonClass: CommsReasonClass): CommsRunPass['sends'][number] =>
  ({ transport, status, reasonClass });

describe('classifyCommsReason', () => {
  it('returns null for the designed states', () => {
    expect(classifyCommsReason('KILL halts all sends.')).toBeNull();
    expect(classifyCommsReason('Communications are paused.')).toBeNull();
    expect(classifyCommsReason('No owner standing approval for this recipient. Novel recipients need the owner.')).toBeNull();
  });

  it('maps the recognized producer vocabulary to its class', () => {
    expect(classifyCommsReason('No channel adapter is available.')).toBe('no-adapter');
    expect(classifyCommsReason('No sanctioned LinkedIn connector is registered.')).toBe('no-connector');
    expect(classifyCommsReason('Delivery outcome unknown; reconcile before retry.')).toBe('delivery-unknown');
    expect(classifyCommsReason('Standing approvals file is not a private owner file.')).toBe('approvals-file');
    expect(classifyCommsReason('Approval overrides are refused.')).toBe('approvals-file');
    expect(classifyCommsReason('Unknown transport.')).toBe('send-policy');
    expect(classifyCommsReason('Credentials must be Phantom Secrets handles.')).toBe('send-policy');
    expect(classifyCommsReason('Recipient is missing.')).toBe('send-policy');
    expect(classifyCommsReason('Message text is not sendable.')).toBe('send-policy');
    expect(classifyCommsReason('LinkedIn sends only through an official API or a sanctioned connector.')).toBe('send-policy');
    expect(classifyCommsReason('LinkedIn mode scrape is not sendable.')).toBe('send-policy');
    expect(classifyCommsReason('Recipient is not an explicitly allowlisted team identity.')).toBe('channel');
    expect(classifyCommsReason('Communication approval is not confirmed.')).toBe('channel');
    expect(classifyCommsReason('Envelope is not a valid bus message.')).toBe('channel');
    expect(classifyCommsReason('Envelope is for a different channel.')).toBe('channel');
    expect(classifyCommsReason('Bus store is busy.')).toBe('channel');
    expect(classifyCommsReason('Bus store refused the envelope.')).toBe('channel');
  });

  it('classifies unrecognized and oversized adapter text as other', () => {
    expect(classifyCommsReason('Connector exploded with token ghp_secretvalue123')).toBe('other');
    expect(classifyCommsReason('x'.repeat(2000))).toBe('other');
  });
});

describe('parseCommsRunPasses', () => {
  it('keeps valid records and their adverse sends only', () => {
    const rows = [
      run('2026-11-23T10:00:00.000Z', [
        ['slack', 'refused', 'Bus store is busy.'],
        ['slack', 'sent', 'Owner standing approval covers this recipient.'],
        ['email', 'drafted', 'No owner standing approval for this recipient. Novel recipients need the owner.'],
        ['email', 'refused', 'KILL halts all sends.'],
        ['bus', 'drafted', 'No channel adapter is available.'],
      ]),
      run('2026-11-23T11:00:00.000Z', [['telegram', 'refused', 'Adapter said something custom']]),
      // foreign schema
      run('2026-11-23T11:30:00.000Z', [['slack', 'refused', 'Bus store is busy.']], { schema: 'other.v1' }),
      // bad transport / status / reason type
      run('2026-11-23T11:45:00.000Z', [['pager', 'refused', 'Bus store is busy.']]),
      run('2026-11-23T11:50:00.000Z', [['slack', 'queued', 'Bus store is busy.']]),
      run('2026-11-23T11:55:00.000Z', [['slack', 'refused', 42 as unknown as string]]),
      // outside window / future / missing timestamp / missing sends
      run('2026-11-10T10:00:00.000Z', [['slack', 'refused', 'Bus store is busy.']]),
      run('2026-11-24T10:00:00.000Z', [['slack', 'refused', 'Bus store is busy.']]),
      JSON.stringify({ schema: SCHEMA, sends: [['slack', 'refused', 'Bus store is busy.']] }),
      JSON.stringify({ at: '2026-11-23T10:00:00.000Z', schema: SCHEMA }),
      'not json at all',
      '',
    ].join('\n');
    const passes = parseCommsRunPasses(rows, CUTOFF, NOW);
    expect(passes).toHaveLength(2);
    expect(passes[0]!.sends).toEqual([
      { transport: 'slack', status: 'refused', reasonClass: 'channel' },
      { transport: 'bus', status: 'drafted', reasonClass: 'no-adapter' },
    ]);
    expect(passes[1]!.sends).toEqual([
      { transport: 'telegram', status: 'refused', reasonClass: 'other' },
    ]);
  });

  it('drops records whose sends are all healthy or designed', () => {
    const rows = [
      run('2026-11-23T10:00:00.000Z', [
        ['slack', 'sent', 'Owner standing approval covers this recipient.'],
        ['email', 'drafted', 'No owner standing approval for this recipient. Novel recipients need the owner.'],
        ['bus', 'refused', 'Communications are paused.'],
      ]),
      run('2026-11-23T11:00:00.000Z', []),
    ].join('\n');
    expect(parseCommsRunPasses(rows, CUTOFF, NOW)).toEqual([]);
  });
});

describe('foldCommsRunCells', () => {
  it('groups by transport, status and reason class; a pass counts once per cell', () => {
    const T0 = Date.parse('2026-11-23T08:00:00.000Z');
    const cells = foldCommsRunCells([
      pass(T0, [
        outcome('slack', 'refused', 'channel'),
        outcome('slack', 'refused', 'channel'),
        outcome('bus', 'drafted', 'no-adapter'),
      ]),
      pass(T0 + 60_000, [outcome('slack', 'refused', 'channel')]),
      pass(T0 - DAY, [outcome('slack', 'drafted', 'delivery-unknown')]),
    ]);
    expect(cells.map((c) => [c.transport, c.status, c.reasonClass, c.passes, c.sends, c.days])).toEqual([
      ['slack', 'refused', 'channel', 2, 3, 1],
      ['bus', 'drafted', 'no-adapter', 1, 1, 1],
      ['slack', 'drafted', 'delivery-unknown', 1, 1, 1],
    ]);
    const slack = cells[0]!;
    expect(slack.firstSeen).toBe(new Date(T0).toISOString());
    expect(slack.lastSeen).toBe(new Date(T0 + 60_000).toISOString());
    expect(slack.lowerBound).toBe(false);
  });

  it('spans days across a cell when its passes land on different UTC dates', () => {
    const T0 = Date.parse('2026-11-23T08:00:00.000Z');
    const cells = foldCommsRunCells([
      pass(T0, [outcome('slack', 'refused', 'channel')]),
      pass(T0 + DAY, [outcome('slack', 'refused', 'channel')]),
      pass(T0 + 2 * DAY, [outcome('slack', 'refused', 'channel')]),
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.passes).toBe(3);
    expect(cells[0]!.days).toBe(3);
  });
});

describe('commsRunBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW_MS = Date.now();
  const iso = (minAgo: number): string => new Date(NOW_MS - minAgo * 60_000).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'comms-run-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A scratch journal at an explicit path. */
  async function journal(name: string, rows: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'runs.jsonl');
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }
  /** Three completed passes on two UTC days: 60 and 120 min ago share a day; 2000 min ago guarantees a second. */
  const recurring = (sends: SendSpec[]): string[] => [
    run(iso(60), sends), run(iso(120), sends), run(iso(2000), sends),
  ];

  it('emits an item for a recurring non-delivery cell', async () => {
    const path = await journal('j1', recurring([['slack', 'refused', 'Bus store is busy.']]));
    const items = await commsRunBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'comms-runs' });
    expect(item!.id).toMatch(/^fleet-comms-run-[0-9a-f]{16}$/);
    expect(item!.title).toContain("'slack'");
    expect(item!.title).toContain('refused');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('comms-agent.run.v1');
    expect(item!.prompt).toContain('runs.jsonl');
    expect(item!.prompt).toContain('no-change');
    // Handles and free-text reasons never reach the prompt.
    expect(item!.prompt).not.toContain('handle-recipient-9');
    expect(item!.prompt).not.toContain('Bus store is busy.');
  });

  it('keeps transports, statuses and reason classes in separate cells', async () => {
    const path = await journal('j2', [
      ...recurring([['slack', 'refused', 'Bus store is busy.']]),
      ...recurring([['bus', 'drafted', 'No channel adapter is available.']]),
      ...recurring([['slack', 'drafted', 'Delivery outcome unknown; reconcile before retry.']]),
    ]);
    const items = await commsRunBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    const titles = items.map((i) => i.title);
    expect(titles.some((t) => t.includes("'slack'") && t.includes('refused'))).toBe(true);
    expect(titles.some((t) => t.includes("'bus'") && t.includes('drafts'))).toBe(true);
    expect(titles.some((t) => t.includes('delivery outcome unknown'))).toBe(true);
  });

  it('emits nothing below the recurring bars of passes and days', async () => {
    // Two passes only — under the pass bar even across two days.
    const thinPasses = await journal('j3a', [
      run(iso(60), [['slack', 'refused', 'Bus store is busy.']]),
      run(iso(2000), [['slack', 'refused', 'Bus store is busy.']]),
    ]);
    expect(await commsRunBacklogItems({ repo: 'ashlrai/phantom', journalPath: thinPasses, now: new Date(NOW_MS) })).toEqual([]);
    // Three passes all inside one UTC day — under the day bar. Fixed timestamps guarantee one day.
    const sameDay = await journal('j3b', [
      run('2026-11-23T01:00:00.000Z', [['slack', 'refused', 'Bus store is busy.']]),
      run('2026-11-23T05:00:00.000Z', [['slack', 'refused', 'Bus store is busy.']]),
      run('2026-11-23T09:00:00.000Z', [['slack', 'refused', 'Bus store is busy.']]),
    ]);
    expect(await commsRunBacklogItems({ repo: 'ashlrai/phantom', journalPath: sameDay, now: new Date('2026-11-23T12:00:00.000Z') })).toEqual([]);
    // Designed states only — the policy working, never evidence.
    const designed = await journal('j3c', recurring([
      ['email', 'drafted', 'No owner standing approval for this recipient. Novel recipients need the owner.'],
      ['slack', 'refused', 'KILL halts all sends.'],
      ['bus', 'refused', 'Communications are paused.'],
    ]));
    expect(await commsRunBacklogItems({ repo: 'ashlrai/phantom', journalPath: designed, now: new Date(NOW_MS) })).toEqual([]);
    expect(COMMS_RUN_MIN_PASSES).toBe(3);
    expect(COMMS_RUN_MIN_DAYS).toBe(2);
  });

  it('emits nothing for a missing journal or another repository', async () => {
    expect(await commsRunBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'no-such.jsonl'), now: new Date(NOW_MS) })).toEqual([]);
    const path = await journal('j4', recurring([['slack', 'refused', 'Bus store is busy.']]));
    expect(await commsRunBacklogItems({ repo: 'ashlrai/other', journalPath: path, now: new Date(NOW_MS) })).toEqual([]);
    expect(await commsRunBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: path, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('reads the default journal under ~/.ashlr-runs when no override is given', async () => {
    const dir = join(home, '.ashlr-runs', 'comms-agent');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'runs.jsonl'), recurring([['slack', 'refused', 'Bus store is busy.']]).join('\n') + '\n');
    const items = await commsRunBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain("'slack'");
  });

  it('honours ASHLR_RUNS_DIR and an empty env value falls back to the home runs dir', async () => {
    const custom = join(home, 'custom-runs');
    await mkdir(join(custom, 'comms-agent'), { recursive: true });
    await writeFile(join(custom, 'comms-agent', 'runs.jsonl'), recurring([['slack', 'refused', 'Bus store is busy.']]).join('\n') + '\n');
    process.env.ASHLR_RUNS_DIR = custom;
    expect(await commsRunBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toHaveLength(1);
    // Explicit runsDir wins over the env.
    const other = join(home, 'other-runs');
    await mkdir(join(other, 'comms-agent'), { recursive: true });
    await writeFile(join(other, 'comms-agent', 'runs.jsonl'), recurring([['bus', 'drafted', 'No channel adapter is available.']]).join('\n') + '\n');
    const viaOpt = await commsRunBacklogItems({ repo: 'ashlrai/phantom', runsDir: other, now: new Date(NOW_MS) });
    expect(viaOpt).toHaveLength(1);
    expect(viaOpt[0]!.title).toContain("'bus'");
    // Empty env is no dir at all — falls back to ~/.ashlr-runs, not cwd.
    process.env.ASHLR_RUNS_DIR = '';
    const fallback = join(home, '.ashlr-runs', 'comms-agent');
    await mkdir(fallback, { recursive: true });
    await writeFile(join(fallback, 'runs.jsonl'), recurring([['telegram', 'refused', 'Adapter said something custom']]).join('\n') + '\n');
    const items = await commsRunBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain("'telegram'");
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const path = await journal('j5', recurring([['slack', 'refused', 'Bus store is busy.']]));
    const pad = 'x'.repeat(1_200 * 1024);
    await writeFile(path, pad + '\n' + recurring([['slack', 'refused', 'Bus store is busy.']]).join('\n') + '\n');
    const items = await commsRunBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const path = await journal('j6', [
      ...recurring([['slack', 'refused', 'Bus store is busy.']]),
      ...recurring([['bus', 'drafted', 'No channel adapter is available.']]),
      ...recurring([['email', 'refused', 'Unknown transport.']]),
    ]);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW_MS) };
    const first = await commsRunBacklogItems(opts);
    const second = await commsRunBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(COMMS_RUN_MAX_ITEMS);
    expect(first.length).toBe(3);
    expect(await commsRunBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends comms-run items through discovery and dedupes on refresh', async () => {
    const dir = join(home, '.ashlr-runs', 'comms-agent');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'runs.jsonl'), recurring([['slack', 'refused', 'Bus store is busy.']]).join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const commsItems = first.items.filter((i) => i.id.startsWith('fleet-comms-run-'));
    expect(commsItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(commsItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-comms-run-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-comms-run-'))).toHaveLength(1);
  });
});
