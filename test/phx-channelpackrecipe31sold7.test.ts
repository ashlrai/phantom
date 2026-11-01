import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../examples/channel-context-roundtrip.js';
import type { ChannelAck } from '../src/core/fleet/channel-envelope.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { readInboxEntries } from '../src/core/fleet/mason-inbox.js';

const roots: string[] = [];
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'channel-context-example-'));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(dir: string, prefix = ''): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = join(prefix, entry.name), path = join(dir, entry.name);
      if (entry.isDirectory()) {
        files[`${name}/`] = '<directory>';
        walk(path, name);
      }
      else files[name] = readFileSync(path, 'base64');
    }
  }
  walk(root);
  return files;
}

describe('channel to context example', { timeout: 30_000 }, () => {
  it('persists one interjection and cites the actual bus envelope through receiver restarts', async () => {
    const root = workspace();
    const sent: ChannelAck[] = [];
    const result = await main(['--workspace', root], async ack => { sent.push(ack); });
    expect(result.first.ok).toBe(true);
    if (!result.first.ok || !result.replay) throw new Error('Expected an accepted receipt');
    expect(result.first.ack.status).toBe('accepted');
    expect(result.first.publishState).toBe('published');
    expect(result.replay).toMatchObject({ ok: true, ack: { status: 'duplicate', channel: 'desktop' }, publishState: 'skipped' });
    expect(sent).toEqual(result.acknowledgements);
    expect(sent.map(ack => [ack.channel, ack.status, ack.dedupeKey])).toEqual([
      ['desktop', 'accepted', result.first.envelope.dedupeKey],
      ['desktop', 'duplicate', result.first.envelope.dedupeKey],
    ]);

    const inbox = await readInboxEntries({ runsDir: join(root, 'runs') });
    expect(inbox.sourceState).toBe('healthy');
    expect(inbox.entries).toHaveLength(1);
    expect(inbox.entries[0]).toMatchObject({ source: 'desktop', priority: 'P0', text: result.first.envelope.body });
    const receipts = JSON.parse(readFileSync(join(root, 'runs/channel-receipts/receipts.json'), 'utf8')) as unknown[];
    expect(receipts).toHaveLength(1);
    const stored = JSON.parse(readFileSync(join(root, 'bus/bus-inbox/messages.json'), 'utf8')) as Array<{ envelope: { id: string; body: unknown } }>;
    expect(stored).toHaveLength(1);
    const page = listBusInboxAfter(0, 10, { root: join(root, 'bus') });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('Bus read failed');
    expect(page.messages).toHaveLength(1);
    const envelope = page.messages[0]!.envelope;
    expect(envelope.id).toBe(stored[0]!.envelope.id);
    expect(envelope).toMatchObject({ from: 'mason', to: 'leaders', priority: 'P0', body: {
      kind: 'interjection', channel: 'desktop', text: result.first.envelope.body,
      dedupeKey: result.first.envelope.dedupeKey,
    } });
    expect(Buffer.byteLength(result.pack!, 'utf8')).toBeLessThanOrEqual(result.byteBudget!);
    const lines = result.pack!.trimEnd().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ jobId: `bus/${envelope.id}`, kind: 'notice', from: 'mason', channel: 'leaders', priority: 'P0', truncated: false });
    expect(JSON.parse(lines[0].text)).toEqual(stored[0]!.envelope.body);

    const before = snapshot(root);
    const restarted = await main(['--workspace', root]);
    expect(restarted.first).toMatchObject({ ok: true, ack: { status: 'duplicate' }, publishState: 'skipped' });
    expect(restarted.replay).toMatchObject({ ok: true, ack: { status: 'duplicate' } });
    expect(restarted.pack).toBe(result.pack);
    expect(snapshot(root)).toEqual(before);
  });

  it('rejects the other simulated verified identity without changing any store', async () => {
    const root = workspace();
    const args = ['--workspace', root, '--identity', 'other'];
    const first = await main(args);
    expect(first).toEqual({ first: { ok: false, reason: 'sender-not-allowed' }, acknowledgements: [] });
    expect(snapshot(root)).toEqual({});
    await main(['--workspace', root]);
    const before = snapshot(root);
    expect(await main(args)).toEqual(first);
    expect(snapshot(root)).toEqual(before);
  });

  it('requires an explicit temporary workspace and runs directly', async () => {
    await expect(main([])).rejects.toThrow('Usage:');
    await expect(main(['--workspace', process.cwd()])).rejects.toThrow('temporary directory');
    await expect(main(['--workspace', workspace(), '--identity', 'claimed-mason'])).rejects.toThrow('Usage:');
    const root = workspace();
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'examples/channel-context-roundtrip.ts', '--workspace', root], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    const output = JSON.parse(child.stdout);
    expect(output.first.ack.status).toBe('accepted');
    expect(output.replay.ack.status).toBe('duplicate');
    expect(JSON.parse(output.pack.trim()).kind).toBe('notice');
  });
});
