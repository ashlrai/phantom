import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fixture = readFileSync(new URL('./fixtures/queue/router-queue.md', import.meta.url), 'utf8');
const statuses = ['READY', 'CLAIMED', 'PR-OPEN', 'BLOCKED', 'HOLD', 'PROPOSED', 'SPLIT-PARENT', 'LAND'];
// This only inventories fixture rows. It is deliberately not a queue parser.
const rows = fixture.split('\n').filter(line => line.startsWith('- '));

describe('queue.v1 fixture inventory', () => {
  it.each(statuses)('contains exactly one %s row with a unique fixture id', status => {
    const matching = rows.filter(line => line.startsWith(`- ${status} `));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toContain(`RQ-FIXTURE-${status} `);
    expect(matching[0]).toContain('pool=codex-personal, tier=work, repo=phantom');
  });

  it('contains only the eight requested rows with distinct identifiers', () => {
    expect(rows).toHaveLength(statuses.length);
    expect(new Set(rows.map(line => line.split(' ')[2])).size).toBe(statuses.length);
  });

  it('retains LAND BASE_OVERRIDE and content that a lossy round trip would discard', () => {
    expect(rows.find(line => line.startsWith('- LAND '))).toContain('BASE_OVERRIDE=fixture-integration');
    expect(fixture).toContain('<!-- Preserve comments, blank lines, ordering, punctuation, and unknown fields. -->\n\n');
    expect(fixture).toContain('`code`, commas, and colons: detail. EXTRA=keep-me');
    expect(fixture).toContain('READY in prose is not a status');
    expect(fixture).toContain('\n\nFreeform operator note:');
    expect(fixture.endsWith('\n')).toBe(true);
    expect(fixture).not.toContain('\r');
  });
});

// Task-authorized dependency skip, not a substitute implementation. See the
// fixture README for the evidence and activation checklist. No existing tests
// are skipped or weakened. These cases must bind to the upstream public API.
describe('queue.v1 production contracts', () => {
  const reason = 'SKIPPED: RQ-PHANTOM-DRIVER-1-QUEUE is not merged; queue.v1 module and public contract are absent';
  it.skip(`imports all eight statuses losslessly, including LAND BASE_OVERRIDE (${reason})`);
  it.skip(`exports the fixture byte for byte and reimports without field loss (${reason})`);
  it.skip(`enforces every documented restock skip rule with an eligible control (${reason})`);
});
