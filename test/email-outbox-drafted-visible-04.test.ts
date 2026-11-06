import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetEmailOutbox } from '../src/cli/fleet-email-outbox.js';
import { EMAIL_OUTBOX_MAX_BYTES, readEmailOutbox, sendEmailOutbox } from '../src/core/comms/email-outbox.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { root: string; outbox: string } {
  const root = mkdtempSync(join(tmpdir(), 'outbox-draft-visible-'));
  roots.push(root);
  const outbox = join(root, 'outbox');
  mkdirSync(outbox);
  return { root, outbox };
}

describe('retained email draft visibility', () => {
  it('reports a real pending draft on repeated reads and in the CLI without sending or exposing its body', async () => {
    const { root, outbox } = setup();
    const name = 'reply.reply.eml';
    const raw = 'To: recipient@example.test\nSubject: Hello\n\nprivate body marker';
    writeFileSync(join(outbox, name), raw);
    const transport = vi.fn(async () => ({ ok: true }));
    const result = await sendEmailOutbox({ dir: outbox, allowedRecipients: new Set(), transport, draftsRunsDir: root });
    expect(result).toMatchObject({ drafted: 1, sent: 0 });
    expect(transport).not.toHaveBeenCalled();
    const store = join(root, 'drafts', 'drafts.jsonl');
    const before = readFileSync(store, 'utf8');
    expect(JSON.parse(before).status).toBe('pending');
    const listing = readEmailOutbox(outbox);
    expect(listing.counts).toEqual({ queued: 0, sent: 0, stuck: 0, drafted: 1 });
    expect(listing.entries).toEqual([{ name, state: 'drafted', to: 'recipient@example.test', subject: 'Hello' }]);
    expect(readEmailOutbox(outbox)).toEqual(listing);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetEmailOutbox(['--dir', outbox, '--json'], { runsDir: root })).toBe(0);
    const output = String(log.mock.calls[0]![0]);
    expect(JSON.parse(output)).toEqual(listing);
    expect(output).not.toContain('private body marker');
    expect(readFileSync(store, 'utf8')).toBe(before);
    expect(readFileSync(join(outbox, 'drafted', name), 'utf8')).toBe(raw);
  });

  it('marks malformed, oversized, non-file and symlink artifacts stuck without disclosing targets', () => {
    const { root, outbox } = setup();
    const drafted = join(outbox, 'drafted');
    mkdirSync(drafted);
    const target = join(root, 'target');
    writeFileSync(target, 'To: secret@example.test\nSubject: target marker\n\nsecret body');
    symlinkSync(target, join(drafted, 'link.reply.eml'));
    writeFileSync(join(drafted, 'bad.reply.eml'), 'not an email');
    writeFileSync(join(drafted, 'big.reply.eml'), 'x'.repeat(EMAIL_OUTBOX_MAX_BYTES + 1));
    mkdirSync(join(drafted, 'dir.reply.eml'));
    const listing = readEmailOutbox(outbox);
    expect(listing.counts).toEqual({ queued: 0, sent: 0, stuck: 4, drafted: 0 });
    expect(listing.entries).toEqual([
      { name: 'bad.reply.eml', state: 'stuck', reason: 'malformed' },
      { name: 'big.reply.eml', state: 'stuck', reason: 'oversized' },
      { name: 'dir.reply.eml', state: 'stuck', reason: 'not-regular' },
      { name: 'link.reply.eml', state: 'stuck', reason: 'symlink' },
    ]);
    expect(JSON.stringify(listing)).not.toContain('target marker');
    expect(JSON.stringify(listing)).not.toContain(target);
    expect(readEmailOutbox(outbox)).toEqual(listing);
  });
});
