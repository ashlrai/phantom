import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CANARY_LADDER_DEFAULT_STATE,
  CANARY_LADDER_EVENTS,
  CANARY_LADDER_STATES,
  enforceGates,
  transitionCanaryLadder,
  type CanaryLadderAuditRecord,
} from '../src/core/fleet/automerge-canary-ladder.js';

const now = () => new Date('2026-10-25T07:00:00Z');
function sink(ok = true) {
  const records: CanaryLadderAuditRecord[] = [];
  return { records, writeAudit: (r: CanaryLadderAuditRecord) => { records.push(r); return ok; }, now };
}

describe('canary enforce ladder', () => {
  it('defaults to shadow; cancellation is proven but enforce support stays pinned false in code', () => {
    expect(CANARY_LADDER_DEFAULT_STATE).toBe('shadow');
    expect(enforceGates()).toEqual({ hostCancellationProven: true, enforceSupported: false });
  });

  it('shadow -> armed is the only forward step available today', () => {
    const s = sink();
    expect(transitionCanaryLadder('shadow', 'arm', s)).toEqual({ ok: true, state: 'armed', auditWritten: true });
    expect(s.records).toEqual([{ schema: 1, kind: 'automerge-canary-ladder', at: '2026-10-25T07:00:00.000Z', from: 'shadow', event: 'arm', to: 'armed', result: 'applied', reason: null }]);
  });

  it('armed -> enforce is refused because enforce support is pinned off (cancellation is proven)', () => {
    const s = sink();
    expect(transitionCanaryLadder('armed', 'enforce', s)).toEqual({ ok: false, state: 'armed', reason: 'enforce-unsupported' });
    expect(s.records[0]).toMatchObject({ from: 'armed', event: 'enforce', to: null, result: 'refused', reason: 'enforce-unsupported' });
  });

  it('enforce is unreachable from every state with every event sequence', () => {
    // Exhaustive walk over all event sequences up to length 4 from shadow.
    const seen = new Set<string>(['shadow']);
    let frontier = ['shadow'];
    for (let depth = 0; depth < 4; depth++) {
      const next: string[] = [];
      for (const st of frontier) for (const ev of CANARY_LADDER_EVENTS) {
        const r = transitionCanaryLadder(st, ev, sink());
        expect(r.state).not.toBe('enforce');
        if (!seen.has(r.state)) { seen.add(r.state); next.push(r.state); }
      }
      frontier = next;
    }
    expect([...seen].sort()).toEqual(['armed', 'shadow']);
  });

  it('every illegal transition is refused and audited', () => {
    const legal = new Set(['shadow:arm', 'shadow:rollback', 'armed:rollback', 'enforce:rollback']);
    for (const st of CANARY_LADDER_STATES) for (const ev of CANARY_LADDER_EVENTS) {
      const s = sink();
      const r = transitionCanaryLadder(st, ev, s);
      expect(s.records).toHaveLength(1);
      if (legal.has(`${st}:${ev}`)) {
        expect(r.ok).toBe(true);
      } else {
        expect(r.ok).toBe(false);
        expect(r.state).toBe(st);
        expect(s.records[0]!.result).toBe('refused');
        expect(['illegal-transition', 'host-cancellation-unproven', 'enforce-unsupported']).toContain((r as { reason: string }).reason);
      }
    }
  });

  it('rollback reaches shadow from any state, including enforce and unknown', () => {
    for (const st of [...CANARY_LADDER_STATES, 'garbage', undefined, 42]) {
      const s = sink();
      expect(transitionCanaryLadder(st, 'rollback', s)).toMatchObject({ ok: true, state: 'shadow' });
      expect(s.records[0]).toMatchObject({ event: 'rollback', to: 'shadow', result: 'applied' });
    }
  });

  it('unknown states and events are refused and fall back to shadow', () => {
    expect(transitionCanaryLadder('enforce-now', 'arm', sink())).toEqual({ ok: false, state: 'shadow', reason: 'state-unknown' });
    expect(transitionCanaryLadder('shadow', 'ENFORCE', sink())).toEqual({ ok: false, state: 'shadow', reason: 'event-unknown' });
    const s = sink();
    transitionCanaryLadder({ evil: true }, '__proto__', s);
    expect(s.records[0]).toMatchObject({ from: 'unknown', event: 'unknown', result: 'refused' });
  });

  it('a failed or throwing audit write blocks escalation but never blocks rollback', () => {
    expect(transitionCanaryLadder('shadow', 'arm', sink(false))).toEqual({ ok: false, state: 'shadow', reason: 'audit-unwritable' });
    expect(transitionCanaryLadder('shadow', 'arm', { writeAudit: () => { throw new Error('disk'); }, now })).toMatchObject({ ok: false, reason: 'audit-unwritable' });
    expect(transitionCanaryLadder('armed', 'rollback', sink(false))).toEqual({ ok: true, state: 'shadow', auditWritten: false });
  });

  it('audit records are value-free: fixed keys, closed values', () => {
    const s = sink();
    transitionCanaryLadder('shadow', 'arm', s);
    transitionCanaryLadder('armed', 'enforce', s);
    for (const r of s.records) expect(Object.keys(r).sort()).toEqual(['at', 'event', 'from', 'kind', 'reason', 'result', 'schema', 'to']);
  });

  it('the gates come from code constants, never config or env', () => {
    const src = readFileSync(new URL('../src/core/fleet/automerge-canary-ladder.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/process\.env|loadConfig|cfg\./);
    const cancel = readFileSync(new URL('../src/core/fleet/automerge-canary-cancel.ts', import.meta.url), 'utf8');
    expect(cancel).toContain('export const HOST_CANCELLATION_PROVEN = true as const;');
    const store = readFileSync(new URL('../src/core/fleet/automerge-canary-store.ts', import.meta.url), 'utf8');
    expect(store).toContain('export const AUTOMERGE_CANARY_ENFORCE_SUPPORTED = false as const;');
    process.env['ASHLR_AUTOMERGE_CANARY_ENFORCE_SUPPORTED'] = '1';
    try { expect(enforceGates().enforceSupported).toBe(false); } finally { delete process.env['ASHLR_AUTOMERGE_CANARY_ENFORCE_SUPPORTED']; }
  });
});
