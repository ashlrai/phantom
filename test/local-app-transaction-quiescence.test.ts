import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain-JS transaction module
import { requireLocalQuiescence } from '../scripts/local-app-transaction.mjs';

const PS = '      1       0 Wed Nov 27 00:00:00 2026 /sbin/launchd\n';

function fixture(fences: Record<string, string>) {
  const home = fs.mkdtempSync(join(tmpdir(), 'phantom-quiescence-'));
  const ledger = join(home, '.ashlr', 'account-connections', 'ledger');
  fs.mkdirSync(ledger, { recursive: true });
  fs.writeFileSync(join(home, '.ashlr', 'KILL'), 'stop\n');
  for (const [name, body] of Object.entries(fences)) {
    fs.writeFileSync(join(ledger, name), body);
  }
  const io = {
    home,
    lstat: (path: string) => {
      let s;
      try { s = fs.lstatSync(path); } catch { return null; }
      return { isFile: s.isFile(), isSymbolicLink: s.isSymbolicLink(), isDirectory: s.isDirectory(), size: s.size };
    },
    exists: (path: string) => fs.existsSync(path),
    readBoundedFile: (path: string) => fs.readFileSync(path, 'utf8'),
    exec: () => ({ status: 0, stdout: PS }),
    executionLeaseCensus: async () => ({ leases: [], unknown: 0, reaped: 0 }),
    log: () => {},
  };
  return { home, io };
}

describe('requireLocalQuiescence collector fences', () => {
  it('ignores fences whose recorded owner is provably dead', async () => {
    const { io } = fixture({
      '.resource-quota-refresh-pending.json': JSON.stringify({ ownerPid: 2147483646 }),
      '.resource-quota-refresh.lock': JSON.stringify({ pid: 2147483647 }),
    });
    await expect(requireLocalQuiescence(io)).resolves.toBeUndefined();
  });
  it('holds while a fence owner is live', async () => {
    const { io } = fixture({ '.resource-quota-refresh.lock': JSON.stringify({ pid: 1 }) });
    await expect(requireLocalQuiescence(io)).rejects.toMatchObject({ code: 'collector-pending' });
  });
  it('holds when fence ownership is unreadable or absent', async () => {
    const { io } = fixture({ '.resource-quota-refresh-pending.json': '{}' });
    await expect(requireLocalQuiescence(io)).rejects.toMatchObject({ code: 'collector-pending' });
  });
});
