import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkOwnerPair, startOwnerPair, type PairDeps } from '../src/core/comms/owner-pair.js';
import { ensureOwnerAdaptersFile } from '../src/core/comms/owner-adapters-file.js';
import { pollPairReplies } from '../src/core/integrations/imessage.js';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => state.home }));

const owner = 'owner@example.test';
let root: string;
let db: string;
const platform = process.platform;
function sql(query: string) { execFileSync('sqlite3', [db, query]); }

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pair-sql-'));
  state.home = root;
  mkdirSync(join(root, 'Library', 'Messages'), { recursive: true });
  db = join(root, 'Library', 'Messages', 'chat.db');
  sql(`CREATE TABLE message (handle_id INTEGER, is_from_me INTEGER, associated_message_type INTEGER, text TEXT);
    CREATE TABLE handle (id TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    INSERT INTO handle VALUES ('owner@example.test'), ('other@example.test');
    INSERT INTO chat_handle_join VALUES (1,1),(1,1),(2,2),(3,1),(3,2),(4,1);
    INSERT INTO message VALUES (0,1,0,'YES'),(1,0,0,'YES'),(0,1,0,'other'),(0,1,0,'group'),(0,1,2000,'tapback'),(0,1,0,'ambiguous');
    INSERT INTO chat_message_join VALUES (1,1),(1,1),(2,3),(3,4),(1,5),(1,6),(2,6);`);
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});
afterAll(() => { Object.defineProperty(process, 'platform', { value: platform, configurable: true }); rmSync(root, { recursive: true, force: true }); });

describe('pair reply SQL against a synthetic Messages database', () => {
  it('selects only unambiguous self-chat and inbound replies, once, after the cursor', async () => {
    expect(await pollPairReplies(0, [owner, 'other@example.test'])).toEqual([
      { rowid: 1, fromMe: true, handle: owner, text: 'YES' },
      { rowid: 2, fromMe: false, handle: owner, text: 'YES' },
      { rowid: 3, fromMe: true, handle: 'other@example.test', text: 'other' },
    ]);
    expect(await pollPairReplies(1, [owner])).toEqual([{ rowid: 2, fromMe: false, handle: owner, text: 'YES' }]);
    expect(await pollPairReplies(0, [owner])).toHaveLength(2);
    expect(await pollPairReplies(0, ['bad handle'])).toBeNull();
  });

  it('limits physical messages in rowid order despite duplicate joins', async () => {
    sql(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<205)
      INSERT INTO message SELECT 0,1,0,'YES' FROM n;
      INSERT INTO chat_message_join SELECT 4, ROWID FROM message WHERE ROWID > 6;
      INSERT INTO chat_message_join SELECT 4, ROWID FROM message WHERE ROWID > 6;`);
    const rows = await pollPairReplies(6, [owner]);
    expect(rows?.map(r => r.rowid)).toEqual(Array.from({ length: 200 }, (_, i) => i + 7));
    expect((await pollPairReplies(206, [owner]))?.map(r => r.rowid)).toEqual([207, 208, 209, 210, 211]);
  });

  it('allows the existing pairing flow to consume the selected reply', async () => {
    const dir = join(root, 'config');
    mkdirSync(dir);
    ensureOwnerAdaptersFile(dir);
    writeFileSync(join(dir, 'comms.toml'), 'confirmedByMason = true\n');
    const sends: string[] = [];
    const deps: PairDeps = { configDir: dir, now: () => Date.UTC(2026, 10, 21), bridge: {
      ownHandles: async () => [owner], baseline: async () => 0,
      send: async (_handle, text) => { sends.push(text); return true; },
      replies: pollPairReplies,
    } };
    expect((await startOwnerPair(deps)).status).toBe('pending');
    expect(await checkOwnerPair(deps)).toEqual({ status: 'bound', confirmed: true });
    expect(sends).toHaveLength(1);
  });
});
