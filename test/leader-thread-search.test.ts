import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listThread } from '../src/core/vision/leader-thread.js';
import { useTmpHome } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();
const rows = [
  { id: 'lt-20260101000000-000001', at: '2026-01-01T00:00:00Z', from: 'leader', channel: 'imessage', kind: 'message', text: 'Dot RELEASE one' },
  { id: 'lt-20260101000001-000002', at: '2026-01-01T00:00:01Z', from: 'mason', channel: 'cli', kind: 'message', text: 'release dot two' },
  { id: 'lt-20260101000002-000003', at: '2026-01-01T00:00:02Z', from: 'leader', channel: 'imessage', kind: 'message', text: 'dot release three' },
  { id: 'lt-20260101000003-000004', at: '2026-01-01T00:00:03Z', from: 'leader', channel: 'cli', kind: 'message', text: 'dot only' },
];
beforeEach(() => {
  home.setup();
  const dir = join(home.home(), '.ashlr', 'vision', 'leader');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'thread.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'), { mode: 0o600 });
});
afterEach(() => home.teardown());
describe('leader thread search', () => {
  it('matches all terms without case sensitivity and applies filters', () => {
    expect(listThread({ q: 'DOT release', channel: 'imessage', from: 'leader' }).map(m => m.id)).toEqual([rows[0]!.id, rows[2]!.id]);
    expect(listThread({ q: 'dot release', from: 'mason' }).map(m => m.id)).toEqual([rows[1]!.id]);
    expect(listThread({ q: 'dot missing' })).toEqual([]);
  });
  it('keeps newest matches in oldest-first order and preserves ordinary reads', () => {
    expect(listThread({ q: 'release', limit: 2 }).map(m => m.id)).toEqual([rows[1]!.id, rows[2]!.id]);
    expect(listThread().map(m => m.id)).toEqual(rows.map(m => m.id));
  });
});
