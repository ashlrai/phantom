import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildReceipt, parseEvents, receiptsEnabled, renderReceipt, type ReceiptEvent } from '../src/core/engineering-receipt.js';
import { cmdReceipt } from '../src/cli/engineering-receipt.js';

const fixture = parseEvents(readFileSync(new URL('./fixtures/receipts/session.jsonl', import.meta.url), 'utf8'));
const cmd = (command: string, exitCode = 0, output = ''): ReceiptEvent => ({ type: 'command', command, exitCode, output });

describe('engineering receipt', () => {
  it('matches expected fields from a fixture event log', () => {
    const r = buildReceipt(fixture, { claims: ['All tests pass', 'Integration tests pass', 'Typecheck is clean', 'Committed the fix'] });
    expect(r.task).toBe('Fix flaky retry in queue worker');
    expect(r.evidence.commitSha).toBe('abc1234');
    expect(r.evidence.typecheck).toBe('pass');
    expect(r.evidence.suites.map((s) => [s.passed, s.failed, s.skipped, s.afterLastEdit])).toEqual([[10, 1, 2, false], [13, 0, 2, true]]);
    expect(r.evidence.integration.map((s) => [s.passed, s.failed])).toEqual([[4, 0]]);
    expect(r.evidence.noCheckAfterEdit).toBe(false);
    expect(r.evidence.verificationScope).toBe('local');
    // typecheck predates the second edit, so that claim is stale
    expect(r.claims.map((c) => c.status)).toEqual(['supported', 'supported', 'UNVERIFIED', 'supported']);
  });

  it('flags a tests-pass claim with no test event as UNVERIFIED', () => {
    const r = buildReceipt([{ type: 'edit', path: 'a.ts' }], { claims: ['tests pass', 'I refactored the module'] });
    expect(r.claims[0]).toMatchObject({ kind: 'tests', status: 'UNVERIFIED', reason: 'no test event recorded' });
    expect(r.claims[1]!.status).toBe('UNVERIFIED');
    expect(renderReceipt(r)).toContain('UNVERIFIED (no test event recorded): tests pass');
  });

  it('flags an edit after the last check, and a stale test claim', () => {
    const r = buildReceipt([cmd('npx vitest run', 0, 'Tests  3 passed (3)'), { type: 'edit', path: 'a.ts' }], { claims: ['tests pass'] });
    expect(r.evidence.noCheckAfterEdit).toBe(true);
    expect(r.claims[0]).toMatchObject({ status: 'UNVERIFIED', reason: 'edit after last test run' });
    expect(renderReceipt(r)).toContain('FLAG no-check-after-edit');
  });

  it('reports deploy as not attempted when absent, and records target when present', () => {
    expect(renderReceipt(buildReceipt(fixture))).toContain('Deploy: not attempted');
    const r = buildReceipt([cmd('vercel deploy --prod'), cmd('curl https://x.example/health')], { claims: ['deployed to prod'] });
    expect(r.evidence.deploy).toEqual({ attempted: true, target: 'prod', ok: true });
    expect(r.evidence.verificationScope).toBe('prod');
    expect(r.claims[0]!.status).toBe('supported');
    expect(buildReceipt([], { claims: ['deployed'] }).claims[0]!.status).toBe('UNVERIFIED');
  });

  it('parses pytest and cargo counts', () => {
    const r = buildReceipt([cmd('pytest', 1, '=== 2 failed, 5 passed, 1 skipped in 0.3s ==='), cmd('cargo test', 0, 'test result: ok. 7 passed; 0 failed; 2 ignored; 0 measured')]);
    expect(r.evidence.suites.map((s) => [s.passed, s.failed, s.skipped])).toEqual([[5, 2, 1], [7, 0, 2]]);
  });

  it('scrubs secrets from every field', () => {
    const secret = ['ghp_', 'A'.repeat(36)].join('');
    const r = buildReceipt([{ type: 'task', text: `use ${secret}` }, cmd(`npx vitest run --token ${secret}`, 0, 'Tests  1 passed (1)')], { claims: [`tests pass with ${secret}`] });
    expect(JSON.stringify(r)).not.toContain('A'.repeat(36));
    expect(renderReceipt(r)).not.toContain('A'.repeat(36));
  });

  it('is gated by PHANTOM_RECEIPTS and the CLI refuses when off', async () => {
    expect(receiptsEnabled({})).toBe(false);
    expect(receiptsEnabled({ PHANTOM_RECEIPTS: '1' })).toBe(true);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = new URL('./fixtures/receipts/session.jsonl', import.meta.url).pathname;
    vi.stubEnv('PHANTOM_RECEIPTS', '');
    expect(await cmdReceipt(['--events', file])).toBe(1);
    vi.stubEnv('PHANTOM_RECEIPTS', '1');
    expect(await cmdReceipt(['--events', file, '--json'])).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]?.[0])).evidence.commitSha).toBe('abc1234');
    expect(await cmdReceipt([])).toBe(2);
    vi.unstubAllEnvs(); err.mockRestore(); out.mockRestore();
  });
});
