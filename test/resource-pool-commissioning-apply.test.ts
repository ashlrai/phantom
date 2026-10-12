/** Offline durability protocol with a fixture-only metadata port; one real witness round-trip below. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyResourcePoolCommissioning, checkResourcePoolCommissioning, resumeResourcePoolCommissioning } from '../src/core/resources/pool-commissioning.js';
import { commissioningHash } from '../src/core/resources/pool-commissioning-custody.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import * as writes from '../src/core/util/private-file-write.js';
import * as native from '../src/core/resources/native-profile.js';
import { independentCommissioningFixture as fixture, saveIndependentJson as save, independentTree as tree } from './support/pool-commissioning-transaction-fixture.js';
const roots: ReturnType<typeof fixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of roots.splice(0)) f.cleanup(); });
function setup(real = false) {
  const f = fixture(real); roots.push(f);
  if (!real) vi.spyOn(native, 'resolveNativeSeatLaunch').mockImplementation(options => {
    const row = f.roster.accounts.find(a => a.id === options.seatId && a.provider === options.provider);
    const profile = [f.personal, f.cmp, f.claude].find(p => p.command[1] === row?.command[1]);
    if (!row || !profile) return { ok: false, reason: 'no-seat', detail: 'inert fixture' };
    return { ok: true, launch: { seatId: row.id, provider: profile.provider, command: profile.command as [string,string],
      nativeStatePath: profile.nativeStatePath, executable: profile.executable } };
  });
  const plan = checkResourcePoolCommissioning(f.request);
  return { f, plan, input: { ...f.request, expectedPlanDigest: plan.planDigest }, directory: join(f.root, 'pool-commissioning', commissioningHash(f.request)) };
}

describe.skipIf(process.platform !== 'darwin')('offline commissioning transaction', () => {
  it('completes actual witnessed locator enrollment while preserving every prior receipt and operator revision', () => {
    const { f, input, plan } = setup(true); const original = structuredClone(f.state);
    const result = applyResourcePoolCommissioning(input);
    expect(result).toMatchObject({ status: 'applied', disposition: 'created', stateChanged: true, providerContacted: false, executionAuthorized: false });
    const state = f.ledger(); expect(state.configurationHistory).toHaveLength(3);
    expect(state.configurationHistory.slice(0,2)).toEqual(original.configurationHistory);
    for (const key of ['attempts','allocation','workerAccess','quotaScopeAccess']) expect(state[key]).toEqual(original[key as keyof typeof original]);
    expect(f.currentPool()).toEqual(f.active.pool);
    expect(f.currentBindings().filter((b: {capacityKey:string}) => b.capacityKey === 'personal').map((b:{command:string[]}) => b.command)).toEqual([f.personal.command,f.personal.command]);
    expect(f.currentQuota().workers.map((w:{workerId:string}) => w.workerId)).toEqual(['general','cmp','spark']);
    expect(state.pendingEvolution).toBeUndefined(); expect(existsSync(f.invoked)).toBe(false);
    expect(checkResourcePoolCommissioning(f.request).planDigest).toBe(plan.planDigest);
  });
  it.each(['before-pool.json','after-pool.json','journal.json','barrier','pool.json','bindings.json','quota-config.json','ready.json','final-ledger'])('recovers exact complete durable prefix after %s', at => {
    const { f, input, directory } = setup(); const original = writes.writePrivateFileAtomically; let crashed = false;
    vi.spyOn(writes, 'writePrivateFileAtomically').mockImplementation((tmp,target,bytes,options) => {
      original(tmp,target,bytes,options);
      const selected = at === 'barrier' ? target === join(f.root,'pool-state.json') && String(bytes).includes('pendingEvolution') :
        at === 'final-ledger' ? target === join(f.root,'pool-state.json') && !String(bytes).includes('pendingEvolution') : target.endsWith(`/${at}`);
      if (!crashed && selected) { crashed = true; throw new Error('injected durable boundary'); }
    });
    expect(() => applyResourcePoolCommissioning(input)).toThrow(); expect(crashed).toBe(true); vi.restoreAllMocks();
    // Use the same inert metadata port after restoring fault injection.
    vi.spyOn(native, 'resolveNativeSeatLaunch').mockImplementation(options => {
      const p = options.seatId === 'new-personal' ? f.personal : options.seatId === 'new-cmp' ? f.cmp : f.claude;
      return {ok:true,launch:{seatId:options.seatId!,provider:p.provider,command:p.command as [string,string],nativeStatePath:p.nativeStatePath,executable:p.executable}};
    });
    if (existsSync(directory)) {
      if (f.ledger().pendingEvolution) expect(() => resourcePoolStatus(f.root,f.currentPool(),f.currentBindings(),[])).toThrow();
      const result = resumeResourcePoolCommissioning(input); expect(['resumed','replayed']).toContain(result.disposition);
    } else {
      expect(() => resumeResourcePoolCommissioning(input)).toThrow();
      expect(applyResourcePoolCommissioning(input).status).toBe('applied');
    }
    expect(f.ledger().attempts).toEqual(f.state.attempts); expect(existsSync(f.invoked)).toBe(false);
  });
  it('refuses unknown partial staging bytes without deleting or publishing them', () => {
    const {f,input} = setup(); const staging=join(f.root,`.pool-commissioning-stage-${commissioningHash(f.request)}`);
    mkdirSync(staging,{mode:0o700}); writeFileSync(join(staging,'before-pool.json'),'{',{mode:0o600}); const before=tree(f.base);
    expect(() => applyResourcePoolCommissioning(input)).toThrow(); expect(readFileSync(join(staging,'before-pool.json'),'utf8')).toBe('{');
    expect(f.ledger()).toEqual(f.state); expect(existsSync(join(f.root,'pool-commissioning',commissioningHash(f.request)))).toBe(false);
    expect(tree(f.base)).toEqual(before);
  });
  it('refuses resume without immutable custody and never creates a new transaction', () => {
    const {f,input}=setup(); const before=tree(f.base); expect(() => resumeResourcePoolCommissioning(input)).toThrow(); expect(tree(f.base)).toEqual(before);
  });
  it.each(['journal.json','ready.json','before-pool.json','after-pool.json'])('holds runtime and replay after completed %s disappears', name => {
    const {f,input,directory}=setup(); applyResourcePoolCommissioning(input); rmSync(join(directory,name)); const before=tree(f.base);
    expect(() => resourcePoolStatus(f.root,f.currentPool(),f.currentBindings(),[])).toThrow(/custody/);
    expect(() => applyResourcePoolCommissioning(input)).toThrow(); expect(tree(f.base)).toEqual(before); expect(existsSync(f.invoked)).toBe(false);
  });
  it('keeps a retained approved digest invalid after console proof/count tampering, even with a recalculated ready hash', () => {
    const {f,input,directory}=setup(); applyResourcePoolCommissioning(input);
    const journal=JSON.parse(readFileSync(join(directory,'journal.json'),'utf8')); journal.plan.preservedReceiptCount=0; journal.consoleProof.jobs=[];
    save(join(directory,'journal.json'),journal); save(join(directory,'ready.json'),{schemaVersion:1,planDigest:input.expectedPlanDigest,journalDigest:commissioningHash(journal)});
    expect(() => resourcePoolStatus(f.root,f.currentPool(),f.currentBindings(),[])).toThrow(/custody/); expect(() => resumeResourcePoolCommissioning(input)).toThrow();
  });
  it.each(['pool.json','bindings.json','quota-config.json'])('never reports applied with %s substituted back before final publication', name => {
    const {f,input}=setup(); const before=readFileSync(join(f.accountsRoot,name)); const original=writes.writePrivateFileAtomically; let changed=false;
    vi.spyOn(writes,'writePrivateFileAtomically').mockImplementation((tmp,target,bytes,options) => {
      original(tmp,target,bytes,options);
      if (!changed && target.endsWith('/ready.json')) { changed=true; writeFileSync(join(f.accountsRoot,name),before); }
    });
    expect(() => applyResourcePoolCommissioning(input)).toThrow(); expect(changed).toBe(true); expect(f.ledger().pendingEvolution).toBeDefined();
  });
  it('keeps the barrier if the published ready proof is removed before final ledger publication', () => {
    const {f,input,directory}=setup();const original=writes.writePrivateFileAtomically;
    vi.spyOn(writes,'writePrivateFileAtomically').mockImplementation((tmp,target,bytes,options)=>{
      original(tmp,target,bytes,options);if(target===join(directory,'ready.json'))rmSync(target);
    });
    expect(()=>applyResourcePoolCommissioning(input)).toThrow();expect(f.ledger().pendingEvolution).toBeDefined();expect(existsSync(f.invoked)).toBe(false);
  });
  it.each(['pool.json','bindings.json','quota-config.json'])('refuses finalized replay when %s is corrupted', name => {
    const {f,input}=setup(); applyResourcePoolCommissioning(input); writeFileSync(join(f.accountsRoot,name),'{'); const before=tree(f.base);
    expect(() => applyResourcePoolCommissioning(input)).toThrow(); expect(tree(f.base)).toEqual(before);
  });
  it('preserves later legitimate allocation and pause revisions through idempotent replay', () => {
    const {f,input}=setup(); applyResourcePoolCommissioning(input); const pool=f.currentPool();const bindings=f.currentBindings();
    setResourcePoolAllocation(f.root,pool,bindings,60,7);
    setResourceWorkerAccess(f.root,pool,bindings,['claude','cmp'],4);
    const before=tree(f.base); const result=applyResourcePoolCommissioning(input);
    expect(result).toMatchObject({disposition:'replayed',stateChanged:false}); expect(tree(f.base)).toEqual(before);
  });
  it('preserves a quota marker injected during publication and refuses further mutation', () => {
    const {f,input}=setup(); const original=writes.writePrivateFileAtomically;const marker=join(f.root,'.resource-quota-refresh-pending.json');let injected=false;
    vi.spyOn(writes,'writePrivateFileAtomically').mockImplementation((tmp,target,bytes,options)=>{
      original(tmp,target,bytes,options); if (!injected && target===join(f.accountsRoot,'bindings.json')) {injected=true;save(marker,{unknown:'do-not-clear'});}
    });
    expect(()=>applyResourcePoolCommissioning(input)).toThrow(/uncertain-work/);expect(readFileSync(marker,'utf8')).toContain('do-not-clear');expect(f.ledger().pendingEvolution).toBeDefined();
  });
});
