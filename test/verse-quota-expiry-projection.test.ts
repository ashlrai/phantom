import { describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(()=>({accounts:[] as Array<Record<string,unknown>>}));
vi.mock('../src/core/verse/accounts.js',()=>({getVerseAccountCollector:()=>null,buildVerseAccountsSnapshot:()=>({accounts:fixture.accounts,evidenceSource:'shared-evidence'})}));
import { buildSeatTelemetry } from '../src/core/verse/seats.js';

describe('native telemetry original expiry',()=>{
  it.each(['claude','codex','grok'])('copies original %s quota expiry without renewal or credit coupling',provider=>{
    const observedAt='2026-10-12T12:00:00.000Z',expiresAt='2026-10-12T12:01:00.000Z';
    fixture.accounts=[{id:'inert',provider,label:'Inert',state:'observed',authentication:'signed-in',health:'reachable',observedAt,expiresAt,windows:[],binding:null,credits:null,notes:[],onDemandEnabled:null,planType:null}];
    const seat=buildSeatTelemetry('/inert-not-read',{collector:null}).get('inert')!;
    expect(seat.capacity.observedAt).toBe(observedAt);
    expect(seat.capacity.quotaExpiresAt).toBe(expiresAt);
    expect(seat.capacity.creditsExpiresAt).toBeNull();
    fixture.accounts[0]!.expiresAt=null;
    expect(buildSeatTelemetry('/inert-not-read',{collector:null}).get('inert')!.capacity.quotaExpiresAt).toBeNull();
  });
});
