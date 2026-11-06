import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { orderKey } from '../src/core/fleet/order-trace.js';

test('parses dated headings without the legacy priority format', () => {
  const [entry] = parseInbox('## 2026-11-01 23:31 ET (from Mason t1270u, relayed by Masbot)\nOrder');
  assert.deepEqual(entry, { at: '2026-11-01 23:31', source: 'from Mason t1270u, relayed by Masbot', priority: null, text: 'Order' });
  assert.equal(orderKey(entry!.at), '11-01 23:31');
  const [memory] = parseInbox('## 2026-11-01 18:06 ET (from Mason, relayed by Masbot) PRIORITY: MEMORY RESILIENCE + RESTART');
  assert.equal(memory!.at, '2026-11-01 18:06');
  assert.equal(memory!.priority, 'MEMORY');
});

test('preserves legacy and undated heading behavior', () => {
  const [legacy] = parseInbox('## 2026-11-01 00:08 ET (Mason, relayed by Masbot) PRIORITY P0 URGENT');
  assert.deepEqual(legacy, { at: '2026-11-01 00:08', source: 'relayed by Masbot', priority: 'P0', text: '' });
  const [undated] = parseInbox('## no date');
  assert.deepEqual(undated, { at: '## no date', source: 'unknown', priority: null, text: '' });
});

test('caps and trims fallback sources and handles missing sources', () => {
  const [entry] = parseInbox(`## 2026-11-01 12:00 (  ${'x'.repeat(90)}  ) PRIORITY P1`);
  assert.equal(entry!.source, 'x'.repeat(80));
  assert.equal(entry!.priority, 'P1');
  assert.equal(parseInbox('## 2026-11-01 12:00')[0]!.source, 'unknown');
});
