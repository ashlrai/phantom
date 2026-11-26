import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readOwnerPairStatus } from '../src/core/comms/owner-pair.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

it('projects expiry at the boundary without changing persisted state, and honors a bound owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-status-expiry-'));
  roots.push(dir);
  mkdirSync(join(dir, 'comms'));
  const file = join(dir, 'comms', 'owner-pair.json');
  const original = JSON.stringify({ pending: { handles: ['fake-handle'], startedAt: 1000, expiresAt: 2000, afterRowId: 1 }, lastStartAt: 1000, autoOff: false });
  writeFileSync(file, original);
  expect(readOwnerPairStatus(dir, 1999)).toEqual({ schema: 'owner-pair.status.v1', state: 'waiting', line: 'waiting for YES (sent to 1)', since: new Date(1000).toISOString(), sent: 1 });
  for (const now of [2000, 2001]) {
    expect(readOwnerPairStatus(dir, now)).toEqual({ schema: 'owner-pair.status.v1', state: 'not-paired', line: 'not paired (invitation expired)' });
  }
  writeFileSync(join(dir, 'agent-network.toml'), '[mason]\nidentities = [{ channel = "imessage", id = "fake-owner" }]\n');
  expect(readOwnerPairStatus(dir, 2001)).toMatchObject({ state: 'paired', line: 'paired (**er)' });
  expect(readFileSync(file, 'utf8')).toBe(original);
});
