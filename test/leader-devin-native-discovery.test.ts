import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { makePolicy } from './helpers/leader-310b-fakes.js';

const h=vi.hoisted(()=>({bin:'',credentials:'',now:0,policy:null as EffectivePolicy|null,catalog:'',authReads:0,changePrincipal:false,
  metadata:vi.fn(async (_bin:string,args:readonly string[])=>args[0]==='auth'
    ? `Logged in\nUser ID: ${++h.authReads===2 && h.changePrincipal?'changed-native':'fixture-native'}\nTeam ID: fixture-team\nAPI server: https://server.codeium.com\nDevin API: https://api.devin.ai\n` : h.catalog)}));
vi.mock('../src/core/verse/seats.js',()=>({discoverSeats:vi.fn(async()=>({seats:[],launches:new Map(),localRuntime:{dispatch:null}}))}));
vi.mock('../src/core/routing/budget-store.js',()=>({readCapacitySnapshot:()=>null,loadBudgetPolicy:()=>defaultBudgetPolicy(),recordShadowDecision:vi.fn()}));
vi.mock('../src/core/authority/effective-config.js',async original=>({...await original<typeof import('../src/core/authority/effective-config.js')>(),currentStandingPolicy:()=>h.policy}));
vi.mock('../src/core/devin/cli-admission.js',async original=>{
  const actual=await original<typeof import('../src/core/devin/cli-admission.js')>();
  return {...actual,refreshDevinCliExecutionBindings:(opts:import('../src/core/devin/cli-admission.js').DevinCliAdmissionOptions)=>
    actual.refreshDevinCliExecutionBindings({...opts,cliPath:h.bin,credentialsPath:h.credentials,now:()=>h.now,runMetadata:h.metadata})};
});
import { loadDefaultLeaderSeatDeps, resolveLeaderSeat } from '../src/core/vision/leader-seat.js';
import { refreshDevinCliExecutionBinding, resetDevinCliAdmissionForTest } from '../src/core/devin/cli-admission.js';
const cfg={devin:{enabled:true,fleet:true}} as AshlrConfig;
const CATALOG='Available models (1 family)\nNative (native)\n  free-flash  Free Flash  [128K context, Free]\n  paid-model  Paid Model  [128K context, $2 / 1M Input]\n';
let root:string;
beforeEach(()=>{
  resetDevinCliAdmissionForTest();h.now=Date.parse('2026-11-06T23:00:00Z');vi.spyOn(Date,'now').mockImplementation(()=>h.now);
  root=realpathSync(mkdtempSync(join(tmpdir(),'leader-native-devin-')));h.bin=join(root,'devin');h.credentials=join(root,'data/devin/credentials.toml');
  mkdirSync(join(root,'data/devin'),{recursive:true,mode:0o700});writeFileSync(h.bin,'#!/bin/sh\nexit 0\n',{mode:0o755});writeFileSync(h.credentials,'INERT_FIXTURE',{mode:0o600});
  vi.stubEnv('XDG_DATA_HOME',join(root,'data'));h.catalog=CATALOG;h.authReads=0;h.changePrincipal=false;h.metadata.mockClear();
  h.policy=makePolicy({engines:['devin'],spend:{maxMode:'balanced',meteredUsdPerDay:0,seats:{'devin-cli':{seatId:'devin-cli',enabled:true,reserveFloorPercent:0,maxSessionWindowPercent:null,roles:['leader']}}}});
});
afterEach(()=>{resetDevinCliAdmissionForTest();vi.unstubAllEnvs();vi.restoreAllMocks();rmSync(root,{recursive:true,force:true});});

describe.runIf(process.platform!=='win32')('real default Leader native Devin discovery and routing',()=>{
  it('default dependencies discover a real admitted CLI candidate and the real router selects its Free contract',async()=>{
    const deps=await loadDefaultLeaderSeatDeps(cfg);const candidates=await deps.candidates();
    expect(candidates).toHaveLength(1);expect(candidates[0]?.seat).toMatchObject({id:'devin-cli',engine:'devin',models:[{id:'free-flash',contextWindow:128000}],health:{windows:[]}});
    expect(candidates[0]?.seat.accountId).toMatch(/^[a-f0-9]{64}$/);expect(h.metadata).toHaveBeenCalledTimes(3);
    const result=await resolveLeaderSeat(deps,{deep:false,promptChars:100});
    expect(result).toMatchObject({ok:true,choice:{seatId:'devin-cli',engine:'devin',model:'free-flash'}});
    expect(h.metadata).toHaveBeenCalledTimes(3);expect(deps.capacitySnapshot()).toBeNull();
  });
  it.each(['grant-alias','disabled','no-role','engine','config'])('does not contact native metadata for %s refusal',async reason=>{
    const grant=h.policy!;
    if(reason==='grant-alias'){grant.spend.seats.devin={...grant.spend.seats['devin-cli']!,seatId:'devin'};delete grant.spend.seats['devin-cli'];}
    if(reason==='disabled')grant.spend.seats['devin-cli']!.enabled=false;
    if(reason==='no-role')grant.spend.seats['devin-cli']!.roles=['producer'];
    if(reason==='engine')grant.engines=[];
    const deps=await loadDefaultLeaderSeatDeps(reason==='config'?{devin:{enabled:true,fleet:false}} as AshlrConfig:cfg);
    expect(await deps.candidates()).toEqual([]);expect(h.metadata).not.toHaveBeenCalled();
  });
  it.each(['paid','unknown','duplicate','identity'])('withholds a CLI candidate on %s metadata',async reason=>{
    if(reason==='paid')h.catalog=CATALOG.replace('128K context, Free','128K context, $2 / 1M Input');
    if(reason==='unknown')h.catalog=CATALOG.replace('128K context, Free','128K context');
    if(reason==='duplicate')h.catalog=CATALOG+'  free-flash  Contradiction  [128K context, $2 / 1M Input]\n';
    if(reason==='identity')h.changePrincipal=true;
    const deps=await loadDefaultLeaderSeatDeps(cfg);expect(await deps.candidates()).toEqual([]);
  });
  it.each(['expiry','credentials','principal','context','grant'])('rechecks %s between selection and native contact',async reason=>{
    const deps=await loadDefaultLeaderSeatDeps(cfg);let admitted:(()=>boolean)|undefined;
    deps.transports.native=(_seat,_engine,_model,check)=>{admitted=check;return async()=>check()?'would-contact':'held';};
    const result=await resolveLeaderSeat(deps,{deep:false,promptChars:100});expect(result.ok).toBe(true);expect(admitted?.()).toBe(true);
    if(reason==='expiry')h.now+=60000;
    if(reason==='credentials')writeFileSync(h.credentials,'CHANGED_FIXTURE',{mode:0o600});
    if(reason==='grant')h.policy=null;
    if(reason==='principal'){
      const changed='Logged in\nUser ID: different-native\nTeam ID: fixture-team\nAPI server: https://server.codeium.com\nDevin API: https://api.devin.ai\n';
      await refreshDevinCliExecutionBinding('free-flash',{cliPath:h.bin,credentialsPath:h.credentials,now:()=>h.now,forceRefresh:true,
        runMetadata:async(_bin,args)=>args[0]==='auth'?changed:CATALOG});
    }
    if(reason==='context')await refreshDevinCliExecutionBinding('free-flash',{cliPath:h.bin,credentialsPath:h.credentials,now:()=>h.now,forceRefresh:true,
      runMetadata:async(_bin,args)=>args[0]==='auth'?'Logged in\nUser ID: fixture-native\nTeam ID: fixture-team\nAPI server: https://server.codeium.com\nDevin API: https://api.devin.ai\n':CATALOG.replaceAll('128K','64K')});
    expect(admitted?.()).toBe(false);if(result.ok)expect(await result.complete('system','user')).toBe('held');
  });
});
