/**
 * Stored-proposal scrub memo (RQ-PHANTOM-VERSE-CPU-1).
 *
 * Every proposal list re-ran the full secret scrub over every stored diff —
 * 24 s of a 69 s dashboard snapshot on a 720-proposal inbox, on each poll.
 * The scrub is now memoized by a digest of the exact file bytes. These tests
 * pin that the memo never weakens the scrub: secrets stay redacted on every
 * read, changed bytes are re-scrubbed, callers cannot poison the memo through
 * a returned object, and HOME changes are never served a stale redaction.
 * Hermetic: tmp HOME only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  _storedProposalScrubMemoSizeForTest,
  ensureProposalInbox,
  inboxDir,
  listProposals,
  listProposalsDetailed,
  loadProposal,
} from '../src/core/inbox/store.js';

let tmpHome: string;
let origHome: string | undefined;

// A fake Stripe-style key: long enough for the redactor, never a real secret.
const FAKE_SECRET = `sk_live_${'Z9'.repeat(16)}`;

beforeEach(() => {
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-scrub-memo-')));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.ashlr'), { recursive: true, mode: 0o700 });
  expect(ensureProposalInbox()).toBe(true);
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeStored(id: string, fields: Record<string, unknown> = {}): void {
  const proposal = {
    id, origin: 'manual', kind: 'note', title: `Proposal ${id}`, summary: 'summary',
    status: 'pending', createdAt: new Date().toISOString(), repo: null,
    diff: `--- a/x\n+++ b/x\n+const key = "${FAKE_SECRET}";\n`,
    ...fields,
  };
  fs.writeFileSync(path.join(inboxDir(), `${id}.json`), JSON.stringify(proposal), { mode: 0o600 });
}

describe('stored proposal scrub memo', () => {
  it('redacts on every read, including reads served from the memo', () => {
    writeStored('p-1');
    for (let i = 0; i < 3; i++) {
      const [proposal] = listProposals();
      expect(proposal?.id).toBe('p-1');
      expect(proposal?.diff).not.toContain(FAKE_SECRET);
      expect(JSON.stringify(listProposalsDetailed().proposals)).not.toContain(FAKE_SECRET);
      expect(loadProposal('p-1')?.diff).not.toContain(FAKE_SECRET);
    }
    expect(_storedProposalScrubMemoSizeForTest()).toBeGreaterThan(0);
  });

  it('returns a private copy: mutating a result never changes the next read', () => {
    writeStored('p-2');
    const first = listProposals()[0]!;
    first.title = 'tampered';
    first.diff = FAKE_SECRET;
    const again = listProposals()[0]!;
    expect(again.title).toBe('Proposal p-2');
    expect(again.diff).not.toContain(FAKE_SECRET);
  });

  it('re-scrubs when the stored bytes change', () => {
    writeStored('p-3', { title: 'before' });
    expect(listProposals()[0]?.title).toBe('before');
    writeStored('p-3', { title: `after ${FAKE_SECRET}` });
    const title = listProposals()[0]?.title ?? '';
    expect(title.startsWith('after')).toBe(true);
    expect(title).not.toContain(FAKE_SECRET);
  });

  it('never reuses a redaction made under a different HOME', () => {
    // The scrub library reads HOME/USERPROFILE/homedir() for home-path
    // redaction, so identical bytes under another HOME are a separate entry.
    const homeA = tmpHome;
    writeStored('p-4', { summary: `see ${path.join(homeA, 'notes.txt')}` });
    listProposals();

    const homeB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-scrub-memo-b-')));
    try {
      fs.mkdirSync(path.join(homeB, '.ashlr'), { recursive: true, mode: 0o700 });
      process.env.HOME = homeB;
      expect(ensureProposalInbox()).toBe(true);
      const bytes = fs.readFileSync(path.join(homeA, '.ashlr', 'inbox', 'p-4.json'));
      fs.writeFileSync(path.join(homeB, '.ashlr', 'inbox', 'p-4.json'), bytes, { mode: 0o600 });
      // Under B the memo must not hand back the result computed under A.
      const sizeBefore = _storedProposalScrubMemoSizeForTest();
      listProposals();
      expect(_storedProposalScrubMemoSizeForTest()).toBe(sizeBefore + 1);
    } finally {
      process.env.HOME = homeA;
      fs.rmSync(homeB, { recursive: true, force: true });
    }
  });
});
