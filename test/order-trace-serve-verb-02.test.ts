import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOrderCitations, readOrderTrace } from '../src/core/fleet/order-trace.js';

describe('parseOrderCitations serve-verb forms', () => {
  it('parses "Serve Mason\'s Nov 1 23:31 always-on main-guardian order."', () => {
    assert.deepEqual(parseOrderCitations("Goal: Serve Mason's Nov 1 23:31 always-on main-guardian order."), ['11-01 23:31']);
  });
  it('parses lowercase "serve Mason\'s Nov 1 18:09 order: ..."', () => {
    assert.deepEqual(parseOrderCitations('Goal: serve Mason\'s Nov 1 18:09 order: "Any paid machine ..."'), ['11-01 18:09']);
  });
  it('parses two times carrying one date across "and"', () => {
    assert.deepEqual(parseOrderCitations("Goal: Serve Mason's Nov 1 18:06 restart-continuity and 00:08 actually-running orders."), ['11-01 18:06', '11-01 00:08']);
  });
  it('skips a month-day with no time and keeps the later dated time', () => {
    assert.deepEqual(parseOrderCitations("Goal: Serve Mason's Oct 31 zero-waste and Nov 1 00:08 autonomous-operation orders."), ['11-01 00:08']);
  });
  it('parses "Serving" as a citation verb', () => {
    assert.deepEqual(parseOrderCitations("Goal: Serving Mason's Nov 1 00:08 autonomous-operation order."), ['11-01 00:08']);
  });
  it('does not match "Deserve Mason\'s Nov 1 00:08"', () => {
    assert.deepEqual(parseOrderCitations("Deserve Mason's Nov 1 00:08 order."), []);
  });
});

describe('readOrderTrace serve-verb round trip', () => {
  it('links a queued job that starts "Goal: Serve Mason\'s ..." to its inbox order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'order-trace-serve-verb-02-'));
    try {
      await mkdir(join(root, 'leader'), { recursive: true });
      await writeFile(join(root, 'leader', 'MASON-INBOX.md'),
        '## 2026-11-01 23:31 ET (Mason, Phantom desktop) PRIORITY P0\nAlways-on main-guardian order.\n');
      await mkdir(join(root, 'queue', 'prompts'), { recursive: true });
      await writeFile(join(root, 'queue', 'prompts', 'RQ-PHX-FAKE01.md'),
        "Goal: Serve Mason's Nov 1 23:31 order.\n");
      const trace = await readOrderTrace({ runsDir: root, now: () => 0 });
      const order = trace.orders.find(o => o.key === '11-01 23:31');
      assert.ok(order, 'expected an order with key 11-01 23:31');
      assert.equal(order.source, 'Phantom desktop');
      assert.deepEqual(order.jobs, [{ id: 'RQ-PHX-FAKE01', lane: null, state: 'queued', url: null }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
