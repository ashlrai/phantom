import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetReserves } from '../src/cli/fleet-reserves.js';

const NOW = new Date('2026-11-10T19:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'reserves-')); dirs.push(dir); return dir; };

/** One plainly fake snapshot seat; every nullable field sanitizeSeatCapacity requires is present. */
const snapSeat = (seatId: string, engine: string, free: boolean) => ({
  seatId, engine, free, signedOut: false, reachable: null, contextWindow: null,
  observedAt: null, spentTodayUsd: null, windows: [],
});

function writeSnapshot(dir: string, seats: ReturnType<typeof snapSeat>[]): string {
  const file = join(dir, 'capacity.json');
  writeFileSync(file, `${JSON.stringify({ v: 1, publishedAt: '2026-11-10T18:59:00.000Z', seats })}\n`);
  return file;
}

const FAKE_SEATS = [
  snapSeat('claude-a', 'claude', false),
  snapSeat('codex-a', 'codex', false),
  snapSeat('local:qwen-fake', 'local', true),
  // A devin-engine row would be dropped by the snapshot sanitizer; the seat id
  // is what matters here — engineOfSeatId resolves it to devin for display.
  snapSeat('devin', 'local', true),
];

const capture = () => {
  const lines: string[] = [];
  return { lines, out: (s: string) => lines.push(s) };
};

describe('cmdFleetReserves', () => {
  it('lists every seat and counts only the automatic reserves', async () => {
    const dir = root();
    const capacityFile = writeSnapshot(dir, FAKE_SEATS);
    const { lines, out } = capture();
    const code = await cmdFleetReserves([], { policyFile: join(dir, 'budget.json'), capacityFile, now: NOW, out });
    expect(code).toBe(0);
    const text = lines.join('\n');
    for (const seatId of ['claude-a', 'codex-a', 'local:qwen-fake', 'devin']) expect(text).toContain(seatId);
    expect(text).toContain('claude-a  claude  reserve 40%  session ceiling 70%  source mode-default(balanced)  enabled');
    expect(text).toContain('codex-a  codex  reserve 40%  session ceiling 70%  source mode-default(balanced)  enabled');
    expect(text).toContain('local:qwen-fake  local  reserve 0%  session ceiling none  source mode-default(balanced)  enabled');
    expect(text).toContain('devin  devin  reserve 0%');
    expect(text.split('\n').at(-1)).toBe('2 seats keep usage back automatically');
  });

  it('--json emits the fleet.reserves.v1 schema', async () => {
    const dir = root();
    const capacityFile = writeSnapshot(dir, FAKE_SEATS);
    const { lines, out } = capture();
    const code = await cmdFleetReserves(['--json'], { policyFile: join(dir, 'budget.json'), capacityFile, now: NOW, out });
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const body = JSON.parse(lines[0]!);
    expect(body.schema).toBe('fleet.reserves.v1');
    expect(body.mode).toBe('balanced');
    expect(body.automatic).toBe(2);
    expect(body.seats).toHaveLength(4);
    const claude = body.seats.find((s: { seatId: string }) => s.seatId === 'claude-a');
    expect(claude).toEqual({
      seatId: 'claude-a', engine: 'claude', enabled: true,
      reservePercent: 40, maxSessionWindowPercent: 70, source: 'mode-default',
    });
    const local = body.seats.find((s: { seatId: string }) => s.seatId === 'local:qwen-fake');
    expect(local).toMatchObject({ engine: 'local', reservePercent: 0, maxSessionWindowPercent: null, source: 'mode-default' });
  });

  it('--clear stores reservePercent 0 with no session ceiling, then reports none automatic', async () => {
    const dir = root();
    const policyFile = join(dir, 'budget.json');
    const capacityFile = writeSnapshot(dir, FAKE_SEATS);
    const first = capture();
    expect(await cmdFleetReserves(['--clear'], { policyFile, capacityFile, now: NOW, out: first.out })).toBe(0);
    expect(first.lines.join('\n')).toContain('cleared claude-a');
    expect(first.lines.join('\n')).toContain('cleared codex-a');
    expect(first.lines.join('\n')).not.toContain('local:qwen-fake');
    expect(first.lines.join('\n')).not.toContain('cleared devin');
    const stored = JSON.parse(readFileSync(policyFile, 'utf8'));
    for (const seatId of ['claude-a', 'codex-a']) {
      expect(stored.seats[seatId].reservePercent).toBe(0);
      expect(stored.seats[seatId].enabled).toBe(true);
      expect('maxSessionWindowPercent' in stored.seats[seatId]).toBe(false);
    }
    const second = capture();
    expect(await cmdFleetReserves([], { policyFile, capacityFile, now: NOW, out: second.out })).toBe(0);
    expect(second.lines.join('\n').split('\n').at(-1)).toBe('0 seats keep usage back automatically');
    expect(second.lines.join('\n')).toContain('source stored');
  });

  it('never touches a stored seat the operator set himself', async () => {
    const dir = root();
    const policyFile = join(dir, 'budget.json');
    writeFileSync(policyFile, `${JSON.stringify({
      mode: 'balanced',
      seats: { 'claude-b': { seatId: 'claude-b', enabled: true, reservePercent: 30 } },
      updatedAt: '2026-11-09T00:00:00.000Z',
    })}\n`);
    const capacityFile = writeSnapshot(dir, FAKE_SEATS);
    const read = capture();
    expect(await cmdFleetReserves([], { policyFile, capacityFile, now: NOW, out: read.out })).toBe(0);
    expect(read.lines.join('\n')).toContain('claude-b  claude  reserve 30%  session ceiling none  source stored  enabled');
    const cleared = capture();
    expect(await cmdFleetReserves(['--clear'], { policyFile, capacityFile, now: NOW, out: cleared.out })).toBe(0);
    expect(cleared.lines.join('\n')).not.toContain('claude-b');
    const stored = JSON.parse(readFileSync(policyFile, 'utf8'));
    expect(stored.seats['claude-b']).toEqual({ seatId: 'claude-b', enabled: true, reservePercent: 30 });
  });

  it('--clear --dry-run prints the plan and writes nothing', async () => {
    const dir = root();
    const policyFile = join(dir, 'budget.json');
    const before = `${JSON.stringify({ mode: 'balanced', seats: {}, updatedAt: '2026-11-09T00:00:00.000Z' })}\n`;
    writeFileSync(policyFile, before);
    const capacityFile = writeSnapshot(dir, FAKE_SEATS);
    const { lines, out } = capture();
    expect(await cmdFleetReserves(['--clear', '--dry-run'], { policyFile, capacityFile, now: NOW, out })).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('would clear claude-a');
    expect(text).toContain('would clear codex-a');
    expect(readFileSync(policyFile, 'utf8')).toBe(before);
    expect(readdirSync(dir).filter((f) => f.includes('unreadable'))).toEqual([]);
  });

  it('an unreadable policy file exits 2 with the reason and is not rewritten', async () => {
    const dir = root();
    const policyFile = join(dir, 'budget.json');
    writeFileSync(policyFile, '{ not json');
    const capacityFile = writeSnapshot(dir, FAKE_SEATS);
    const read = capture();
    expect(await cmdFleetReserves([], { policyFile, capacityFile, now: NOW, out: read.out })).toBe(2);
    expect(read.lines.join('\n')).toContain('is not valid JSON');
    const cleared = capture();
    expect(await cmdFleetReserves(['--clear'], { policyFile, capacityFile, now: NOW, out: cleared.out })).toBe(2);
    expect(readFileSync(policyFile, 'utf8')).toBe('{ not json');
    expect(readdirSync(dir).filter((f) => f.includes('unreadable'))).toEqual([]);
    expect(existsSync(join(dir, 'budget.json'))).toBe(true);
  });

  it('prints usage on --help and refuses unknown flags', async () => {
    const dir = root();
    const lines: string[] = [];
    const deps = { policyFile: join(dir, 'budget.json'), capacityFile: join(dir, 'capacity.json'), out: (s: string) => lines.push(s) };
    expect(await cmdFleetReserves(['--help'], deps)).toBe(0);
    expect(lines[0]).toContain('ashlr fleet reserves');
    lines.length = 0;
    expect(await cmdFleetReserves(['--nope'], deps)).toBe(2);
    expect(await cmdFleetReserves(['--dry-run'], deps)).toBe(2);
    expect(await cmdFleetReserves(['--json', '--json'], deps)).toBe(2);
  });
});
