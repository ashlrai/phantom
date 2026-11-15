import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGmailArchivePlan } from '../src/cli/fleet-gmail-archive-plan.js';
import { readFleetGmailArchivePlanLatest } from '../src/mcp/fleet-gmail-archive-plan-latest.js';

const root = mkdtempSync(join(tmpdir(), 'gmail-plan-roundtrip-'));
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

type CliResult = {
  schema: string;
  archivePlan: { unread: number; target: number; archiveCandidates: string[] };
  topSenders: { sender: string; count: number }[];
};

it('preserves both proposed plans from the CLI through the MCP reader', async () => {
  const runsDir = join(root, 'runs');
  const inboxes = [
    { label: 'work-inbox', senders: ['noreply@news.test', 'noreply@news.test', 'newsletter@news.test', 'person@people.test'], target: 1 },
    { label: 'home-inbox', senders: ['digest@updates.test', 'digest@updates.test', 'person@people.test'], target: 1 },
  ];
  const snapshots = new Map<string, Map<string, Buffer>>();
  for (const inbox of inboxes) {
    const dir = join(root, inbox.label);
    mkdirSync(dir);
    const files = new Map<string, Buffer>();
    for (const [i, sender] of inbox.senders.entries()) {
      const name = `message-${i}.eml`;
      const bytes = Buffer.from(`From: ${sender}\nMessage-ID: <${inbox.label}-${i}@example.test>\nSubject: Hello\n\nA synthetic message.\n`);
      writeFileSync(join(dir, name), bytes);
      files.set(name, bytes);
    }
    snapshots.set(dir, files);
  }

  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  async function run(label: string, target: number, noSave = false): Promise<CliResult> {
    log.mockClear();
    error.mockClear();
    const args = ['--dir', join(root, label), '--inbox', label, '--target', String(target), '--runs-dir', runsDir, '--json'];
    if (noSave) args.push('--no-save');
    expect(await cmdFleetGmailArchivePlan(args)).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    return JSON.parse(String(log.mock.calls[0]![0])) as CliResult;
  }

  const results = new Map<string, CliResult>();
  for (const inbox of inboxes) results.set(inbox.label, await run(inbox.label, inbox.target));
  const report = readFleetGmailArchivePlanLatest({}, runsDir);
  expect(report).toMatchObject({ schema: 'fleet.mcp.gmail-archive-plan-latest.v1', state: 'present' });
  expect(report.plans).toHaveLength(2);
  for (const inbox of inboxes) {
    const result = results.get(inbox.label)!;
    expect(result.schema).toBe('fleet.gmail-archive-plan.v1');
    expect(result.archivePlan.unread).toBe(inbox.senders.length);
    expect(result.archivePlan.target).toBe(inbox.target);
    expect(result.archivePlan.archiveCandidates.length).toBeGreaterThan(0);
    const matching = report.plans.filter(plan => plan.inbox === inbox.label);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      unread: result.archivePlan.unread, target: result.archivePlan.target,
      archiveCount: result.archivePlan.archiveCandidates.length, topSenders: result.topSenders,
      overTarget: result.archivePlan.unread > result.archivePlan.target,
    });
    expect(readFleetGmailArchivePlanLatest({ inbox: inbox.label }, runsDir).plans).toEqual(matching);
  }

  const unsaved = await run(inboxes[0]!.label, 0, true);
  expect(unsaved.archivePlan.target).toBe(0);
  expect(readFleetGmailArchivePlanLatest({}, runsDir)).toEqual(report);
  for (const [dir, files] of snapshots) {
    expect(readdirSync(dir).sort()).toEqual([...files.keys()].sort());
    for (const [name, bytes] of files) expect(readFileSync(join(dir, name))).toEqual(bytes);
  }
  expect(readdirSync(root).sort()).toEqual(['home-inbox', 'runs', 'work-inbox']);
  expect(readdirSync(runsDir)).toEqual(['comms']);
  expect(readdirSync(join(runsDir, 'comms'))).toEqual(['gmail-archive-plan-latest.json']);
});
