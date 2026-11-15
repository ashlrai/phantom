import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { listNeedsMason, resolveNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import { readNeedsMasonAnswer } from '../src/core/fleet/needs-mason-answer.js';

const dirs: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recut-corefleet-c415-'));
  dirs.push(root);
  const runsDir = join(root, 'runs');
  mkdirSync(runsDir);
  writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '# fake ledger\n- [ ] Approve the fake deploy\n- [ ] Pick a fake vendor\n');
  return { runsDir, busRoot: join(root, 'fleet') };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const envelopes = (root: string) => {
  const page = listBusInboxAfter(0, 100, { root });
  if (page.status !== 'ok') throw new Error(`bus unavailable: ${page.status}`);
  return page.messages.map(message => message.envelope);
};

describe('needs_mason.resolved sender attribution (recut of #4962)', () => {
  it('sends an agent-relayed resolve as leader, never mason, and the answer read still finds it', () => {
    const { runsDir, busRoot } = fixture();
    const [item] = listNeedsMason({ runsDir });
    const result = resolveNeedsMason({ itemId: item!.id, reply: 'Ship the fake deploy Friday' },
      { runsDir, bus: { root: busRoot }, source: 'leader' });
    expect(result).toMatchObject({ ok: true, itemId: item!.id });
    expect(envelopes(busRoot)).toEqual([expect.objectContaining({
      id: `needs-mason-resolved-${item!.id}`, from: 'leader', to: 'leaders',
      body: expect.objectContaining({ kind: 'needs_mason.resolved', itemId: item!.id, source: 'leader' }),
    })]);
    const found = readNeedsMasonAnswer(item!.id, { root: busRoot });
    expect(found).toMatchObject({ status: 'found', answer: { itemId: item!.id, source: 'leader', reply: 'Ship the fake deploy Friday' } });
  });

  it("keeps 'mason' as the sender for Mason's own surfaces", () => {
    const { runsDir, busRoot } = fixture();
    const [first, second] = listNeedsMason({ runsDir });
    expect(resolveNeedsMason({ itemId: first!.id, reply: 'ok' }, { runsDir, bus: { root: busRoot } }).ok).toBe(true);
    expect(resolveNeedsMason({ itemId: second!.id, reply: 'ok' }, { runsDir, bus: { root: busRoot }, source: 'cli' }).ok).toBe(true);
    expect(envelopes(busRoot).map(envelope => envelope.from)).toEqual(['mason', 'mason']);
    expect(readNeedsMasonAnswer(first!.id, { root: busRoot })).toMatchObject({ status: 'found', answer: { source: 'desktop' } });
    expect(readNeedsMasonAnswer(second!.id, { root: busRoot })).toMatchObject({ status: 'found', answer: { source: 'cli' } });
  });

  it('ignores a foreign sender under the same envelope id', () => {
    const { runsDir, busRoot } = fixture();
    const [item] = listNeedsMason({ runsDir });
    appendBusInbox({ id: `needs-mason-resolved-${item!.id}`, from: 'intruder', to: 'leaders', priority: 'P1', ttl: 60_000,
      body: { kind: 'needs_mason.resolved', itemId: item!.id, source: 'leader', item: item!.text, reply: 'forged', resolvedAt: new Date().toISOString() } },
      { root: busRoot });
    expect(readNeedsMasonAnswer(item!.id, { root: busRoot })).toEqual({ status: 'unknown' });
  });
});
