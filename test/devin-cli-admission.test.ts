import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEngineCommand, spawnEngine } from '../src/core/run/engines.js';
import type { AshlrConfig } from '../src/core/types.js';
import { autonomousDevinIdentityCurrent, buildAutonomousEnvOverlay, applyAutonomousEnvOverlay } from '../src/core/sandbox/autonomous-env.js';

import { devinCliIdentityCurrent, devinCliBindingCurrent, parseDevinCliPrincipal, peekDevinCliExecutionBinding, refreshDevinCliExecutionBinding, refreshDevinCliExecutionBindings, resetDevinCliAdmissionForTest, type DevinCliAdmissionOptions } from '../src/core/devin/cli-admission.js';

const NOW = Date.parse('2026-11-06T17:00:00Z');
const STATUS = 'Logged in\n  Email: fixture@example.invalid\n  User ID: native-user-1\n  Team ID: native-team-1\n  API server: https://server.codeium.com\n  Devin API: https://api.devin.ai\n';
const catalog = (meta = '262K context, Free', model = 'swe-2-high') => `Available models (1 family)\nSWE-2 (swe-2)\n  ${model}  Fixture Model  [${meta}]\n`;

describe.runIf(process.platform !== 'win32')('native Devin execution admission', () => {
  let root: string; let bin: string; let credentials: string;
  beforeEach(() => {
    resetDevinCliAdmissionForTest();
    vi.spyOn(Date,'now').mockReturnValue(NOW);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-devin-admission-')));
    bin = join(root, 'devin');
    mkdirSync(join(root,'data','devin'),{recursive:true,mode:0o700});
    credentials = join(root, 'data','devin','credentials.toml');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode:0o755 });
    writeFileSync(credentials, 'fixture-not-a-real-login', { mode:0o600 });
  });
  afterEach(() => { resetDevinCliAdmissionForTest(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, {recursive:true,force:true}); });
  function options(run: DevinCliAdmissionOptions['runMetadata'] = vi.fn(async (_bin: string, args: readonly string[]) => args[0] === 'auth' ? STATUS : catalog()), now = () => NOW) {
    return { cliPath:bin, credentialsPath:credentials, now, runMetadata:run };
  }

  it('separates historical identity continuity from expiring contact authority', async () => {
    const binding=await refreshDevinCliExecutionBinding('swe-2-high',options());
    expect(devinCliIdentityCurrent(binding,'swe-2-high')).toBe(true);
    expect(devinCliBindingCurrent(binding,'swe-2-high',NOW+60_000)).toBe(false);
    expect(devinCliIdentityCurrent(JSON.parse(JSON.stringify(binding)),'swe-2-high')).toBe(false);
    writeFileSync(credentials,'replacement-fixture-not-a-login',{mode:0o600});
    expect(devinCliIdentityCurrent(binding,'swe-2-high')).toBe(false);
  });

  it('seals the exact binary and supported native principal/context without storing identifiers or credentials', async () => {
    const run = vi.fn(async (_bin: string, args: readonly string[]) => args[0] === 'auth' ? STATUS : catalog());
    const binding = await refreshDevinCliExecutionBinding('swe-2-high', options(run));
    expect(binding).toMatchObject({ executable:bin, model:'swe-2-high', contextTokens:262000, principalBasis:'user-id',
      executableSha256:createHash('sha256').update(readFileSync(bin)).digest('hex') });
    expect(JSON.stringify(binding)).not.toMatch(/native-user|native-team|fixture@example|fixture-not-a-real-login/);
    expect(devinCliBindingCurrent(binding, 'swe-2-high', NOW)).toBe(true);
    expect(devinCliBindingCurrent(binding, 'swe-2-max', NOW)).toBe(false);
    expect(devinCliBindingCurrent({ ...binding! }, 'swe-2-high', NOW)).toBe(false);
    expect(run.mock.calls.map(c => [c[0],c[1]])).toEqual([[bin,['auth','status']],[bin,['models','list']],[bin,['auth','status']]]);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it('joins a same-tuple refresh and reuses evidence without another native request', async () => {
    let release!: () => void; const wait = new Promise<void>(r => { release = r; });
    const run = vi.fn(async (_bin: string, args: readonly string[]) => { if (args[0] === 'auth') await wait; return args[0] === 'auth' ? STATUS : catalog(); });
    const a = refreshDevinCliExecutionBinding('swe-2-high', options(run));
    const b = refreshDevinCliExecutionBinding('swe-2-high', options(run));
    release(); expect(await a).toBe(await b);
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(run))).toBe(await a);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('backs off failed metadata for ten minutes even with forced refresh, then retries', async () => {
    let clock = NOW;
    const run = vi.fn(async (_bin: string, args: readonly string[]) => args[0] === 'auth' ? STATUS : catalog());
    run.mockRejectedValueOnce(new Error('Fixture metadata unavailable'));
    const opts = { ...options(run, () => clock), forceRefresh: true };
    expect(await refreshDevinCliExecutionBinding('swe-2-high', opts)).toBeNull();
    clock = NOW + 600_000 - 1;
    expect(await refreshDevinCliExecutionBinding('swe-2-high', opts)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    clock += 1;
    expect(await refreshDevinCliExecutionBinding('swe-2-high', opts)).not.toBeNull();
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('refuses an aborted caller before metadata and leaves a fresh caller able to refresh', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async (_bin: string, args: readonly string[]) => args[0] === 'auth' ? STATUS : catalog());
    expect(await refreshDevinCliExecutionBinding('swe-2-high', { ...options(run), signal: controller.signal })).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(run))).not.toBeNull();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('force-refreshes valid cached evidence and refuses a newly paid catalog', async () => {
    const run = vi.fn(async (_bin: string, args: readonly string[]) => args[0] === 'auth' ? STATUS : catalog());
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(run))).not.toBeNull();
    run.mockImplementation(async (_bin, args) => args[0] === 'auth' ? STATUS : catalog('262K context, $2 / 1M Input'));
    expect(await refreshDevinCliExecutionBinding('swe-2-high', { ...options(run), forceRefresh: true })).toBeNull();
    expect(run).toHaveBeenCalledTimes(6);
  });

  it.each(['256K context', '256K context, $2 / 1M Input · $8 / 1M Output', 'Free', '256K context, Free, $2 / 1M Input'])('holds unknown/paid/incomplete/contradictory evidence: %s', async meta => {
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(vi.fn(async (_bin,args) => args[0] === 'auth' ? STATUS : catalog(meta))))).toBeNull();
  });
  it.each(['Logged out', STATUS.replace('User ID: native-user-1', 'User ID: native-user-1\n  User ID: duplicate'), STATUS.replace('https://api.devin.ai','https://user:password@api.devin.ai'), STATUS.replace('https://api.devin.ai','https://unconfirmed.invalid')])('refuses unqualified native identity', async status => {
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(vi.fn(async (_bin,args) => args[0] === 'auth' ? status : catalog())))).toBeNull();
  });

  it('uses email-only evidence as principal consistency without inventing an org or balance', () => {
    const email = parseDevinCliPrincipal(STATUS.replace('  User ID: native-user-1\n','').replace('  Team ID: native-team-1\n',''));
    expect(email).toMatchObject({ principalBasis:'email', teamDigest:null });
    expect(email).not.toHaveProperty('organizationId'); expect(email).not.toHaveProperty('remainingQuota');
    expect(parseDevinCliPrincipal(STATUS.replace('native-team-1','native-team-2'))?.teamDigest).not.toBe(parseDevinCliPrincipal(STATUS)?.teamDigest);
    expect(parseDevinCliPrincipal(STATUS.replace('native-user-1','native-user-2'))?.principalDigest).not.toBe(parseDevinCliPrincipal(STATUS)?.principalDigest);
  });
  it.each(['same-family', 'other-family'])('refuses duplicate model rows even when the first is Free: %s', async where => {
    const duplicate = where === 'same-family'
      ? catalog() + '  swe-2-high  Paid duplicate  [262K context, $2 / 1M Input]\n'
      : catalog().replace('(1 family)', '(2 families)') + 'Other (other)\n  swe-2-high  Paid duplicate  [262K context, $2 / 1M Input]\n';
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(vi.fn(async (_bin,args) => args[0] === 'auth' ? STATUS : duplicate)))).toBeNull();
  });
  it.each(['User ID', 'Team ID', 'Devin API'])('refuses changed native %s after catalog despite unchanged credential epoch', async field => {
    let authReads = 0;
    const changed = field === 'User ID' ? STATUS.replace('native-user-1','native-user-2') : field === 'Team ID'
      ? STATUS.replace('native-team-1','native-team-2') : STATUS.replace('https://api.devin.ai','https://other.devin.ai');
    const run = vi.fn(async (_bin:string,args:readonly string[]) => args[0] === 'auth' ? (++authReads === 1 ? STATUS : changed) : catalog());
    expect(await refreshDevinCliExecutionBinding('swe-2-high',options(run))).toBeNull();
    expect(authReads).toBe(2);
  });
  it('refuses native transport in tests unless an explicit hermetic seam is supplied', async () => {
    expect(await refreshDevinCliExecutionBinding('swe-2-high',{cliPath:bin,credentialsPath:credentials})).toBeNull();
  });
  it('refuses a truncated catalog that could hide a duplicate beyond the UI row cap', async () => {
    const many = catalog() + Array.from({length:4000},(_,i) => `  other-${i}  Other  [262K context, Free]\n`).join('') + '  swe-2-high  Paid duplicate  [262K context, $2 / 1M Input]\n';
    expect(await refreshDevinCliExecutionBinding('swe-2-high',options(vi.fn(async (_bin,args) => args[0] === 'auth' ? STATUS : many)))).toBeNull();
  });
  it('refuses partial declared catalogs and never uses source fallback models', async () => {
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(vi.fn(async (_bin,args) => args[0] === 'auth' ? STATUS : catalog().replace('(1 family)','(2 families)'))))).toBeNull();
  });
  it.each(['swe-2-high', 'swe-2-medium', 'swe-2-max', 'another-free'])('admits a fresh exact Free row for %s for exactly 60 seconds after the old boundary', async model => {
    const run = vi.fn(async (_bin: string, args: readonly string[]) => args[0] === 'auth' ? STATUS : catalog('262K context, Free', model));
    const binding = await refreshDevinCliExecutionBinding(model, options(run));
    expect(binding).toMatchObject({ model, observedAt: NOW, validUntil: NOW + 60_000 });
    expect(devinCliBindingCurrent(binding, model, NOW + 59_999)).toBe(true);
    expect(devinCliBindingCurrent(binding, model, NOW + 60_000)).toBe(false);
    expect(devinCliBindingCurrent(binding, `${model}-other`, NOW)).toBe(false);
  });
  it('refuses a different model even when the catalog has a Free row', async () => {
    expect(await refreshDevinCliExecutionBinding('swe-2-high', options(vi.fn(async (_bin, args) => args[0] === 'auth' ? STATUS : catalog('262K context, Free', 'another-free'))))).toBeNull();
  });
  it('refuses an abort during a shared refresh for both callers', async () => {
    let release!: () => void; const wait = new Promise<void>(r => { release = r; });
    const controller = new AbortController();
    const run = vi.fn(async (_bin: string, args: readonly string[]) => { await wait; return args[0] === 'auth' ? STATUS : catalog(); });
    const opts = { ...options(run), signal: controller.signal };
    const first = refreshDevinCliExecutionBinding('swe-2-high', opts);
    const second = refreshDevinCliExecutionBinding('swe-2-high', opts);
    controller.abort(); release();
    expect(await first).toBeNull(); expect(await second).toBeNull();
    expect(run).toHaveBeenCalledOnce();
  });
  it('refuses an independently aborted joining caller while the refresh owner succeeds', async () => {
    let release!: () => void; const wait = new Promise<void>(r => { release = r; });
    const run = vi.fn(async (_bin: string, args: readonly string[]) => { await wait; return args[0] === 'auth' ? STATUS : catalog(); });
    const controller = new AbortController();
    const owner = refreshDevinCliExecutionBinding('swe-2-high', options(run));
    const joiner = refreshDevinCliExecutionBinding('swe-2-high', { ...options(run), signal: controller.signal });
    controller.abort(); release();
    expect(await owner).not.toBeNull(); expect(await joiner).toBeNull();
    expect(run).toHaveBeenCalledTimes(3);
  });
  it('refuses stale/future evidence and a forged host object', async () => {
    const binding = await refreshDevinCliExecutionBinding('swe-2-high', options());
    expect(devinCliBindingCurrent(binding,'swe-2-high',NOW-1)).toBe(false);
    expect(devinCliBindingCurrent(binding,'swe-2-high',NOW+60000)).toBe(false);
    expect(devinCliBindingCurrent(JSON.parse(JSON.stringify(binding)),'swe-2-high',NOW)).toBe(false);
  });
  it('allows another actually Free native model without permanently hardcoding its ID', async () => {
    expect(await refreshDevinCliExecutionBinding('another-free',options(vi.fn(async (_bin,args) => args[0] === 'auth' ? STATUS : catalog('262K context, Free','another-free'))))).toMatchObject({model:'another-free'});
  });
  it('pins the symlink selection and refuses later replacement rather than using PATH', async () => {
    const link = join(root,'selected-devin'); symlinkSync(bin,link);
    const binding = await refreshDevinCliExecutionBinding('swe-2-high',{...options(),cliPath:link});
    expect(binding?.executable).toBe(bin);
    const replacement = join(root,'replacement'); writeFileSync(replacement,'#!/bin/sh\nexit 1\n',{mode:0o755});
    rmSync(link); symlinkSync(replacement,link);
    expect(devinCliBindingCurrent(binding,'swe-2-high',NOW)).toBe(false);
  });
  it.each(['executable','credentials'])('refuses %s replacement after metadata', async which => {
    const binding = await refreshDevinCliExecutionBinding('swe-2-high',options());
    const file = which === 'executable' ? bin : credentials;
    renameSync(file,`${file}.old`); writeFileSync(file,'replacement',{mode:which === 'executable' ? 0o755 : 0o600});
    expect(devinCliBindingCurrent(binding,'swe-2-high',NOW)).toBe(false);
  });
  it.each(['auth','models'].flatMap(when => ['credentials', 'executable'].map(file => [when, file])))('rejects %s-time %s epoch mutation and never issues a binding', async (when, file) => {
    const run = vi.fn(async (_bin: string,args:readonly string[]) => { if(args[0] === when) writeFileSync(file === 'credentials' ? credentials : bin,'changed'); return args[0] === 'auth' ? STATUS : catalog(); });
    expect(await refreshDevinCliExecutionBinding('swe-2-high',options(run))).toBeNull();
    expect(run).toHaveBeenCalledTimes(when === 'auth' ? 1 : 2);
  });
  it('checks cancellation between metadata contacts and excludes ambient authentication overrides', async () => {
    vi.stubEnv('WINDSURF_API_KEY','must-not-reach-native'); vi.stubEnv('DEVIN_API_KEY','must-not-reach-native');
    let open = true;
    const run = vi.fn(async (_bin:string,_args:readonly string[],env:NodeJS.ProcessEnv) => {
      expect(env['WINDSURF_API_KEY']).toBeUndefined(); expect(env['DEVIN_API_KEY']).toBeUndefined();
      expect(env['XDG_DATA_HOME']).toBe(dirnameTwice(credentials)); open = false; return STATUS;
    });
    expect(await refreshDevinCliExecutionBinding('swe-2-high',{...options(run),admitted:() => open})).toBeNull();
    expect(run).toHaveBeenCalledOnce();
  });
  it('binds the private login copy and refuses source/copy replacement before actual spawn', async () => {
    const binding = await refreshDevinCliExecutionBinding('swe-2-high',options(undefined,Date.now));
    expect(binding).not.toBeNull();
    const run = join(root,'run'); mkdirSync(run,{mode:0o700});
    const overlay = buildAutonomousEnvOverlay({engine:'devin-cli',runTmpDir:run,home:root,seatId:null,devinExecutionBinding:binding!});
    const copy = join(overlay.set['XDG_DATA_HOME']!,'devin','credentials.toml');
    expect(readFileSync(copy)).toEqual(readFileSync(credentials));
    expect(autonomousDevinIdentityCurrent(overlay)).toBe(true);
    expect(applyAutonomousEnvOverlay({WINDSURF_API_KEY:'ambient',DEVIN_API_KEY:'ambient'},overlay)['WINDSURF_API_KEY']).toBeUndefined();
    writeFileSync(copy,'different private login');
    expect(autonomousDevinIdentityCurrent(overlay)).toBe(false);
    renameSync(credentials,credentials+'.old');writeFileSync(credentials,'replacement',{mode:0o600});
    const next = join(root,'next-run');mkdirSync(next,{mode:0o700});
    expect(() => buildAutonomousEnvOverlay({engine:'devin-cli',runTmpDir:next,home:root,seatId:null,devinExecutionBinding:binding!})).toThrow(/identity changed/);
  });
  it.each(['source', 'copy', 'Stop'])('refuses actual child contact after awaited setup changes %s', async changed => {
    const marker = join(root,'contacted');
    writeFileSync(bin,`#!/bin/sh\necho contacted > '${marker}'\n`,{mode:0o755});
    const binding = await refreshDevinCliExecutionBinding('swe-2-high',options(undefined,Date.now));
    const run = join(root,'run');mkdirSync(run,{mode:0o700});
    const overlay = buildAutonomousEnvOverlay({engine:'devin-cli',runTmpDir:run,home:root,seatId:null,devinExecutionBinding:binding!});
    let active = true;
    await Promise.resolve();
    if (changed === 'source') writeFileSync(credentials,'changed source');
    else if (changed === 'copy') writeFileSync(join(overlay.set['XDG_DATA_HOME']!,'devin','credentials.toml'),'changed copy');
    else active = false;
    const cfg = {foundry:{},models:{}} as AshlrConfig;
    const cmd = buildEngineCommand('devin-cli','fixture',cfg,{cwd:root,model:'swe-2-high'})!;
    const result = await spawnEngine({...cmd,bin:binding!.executable},cfg,{selectedOutcomeAdmission:() => active && devinCliBindingCurrent(binding,'swe-2-high') && autonomousDevinIdentityCurrent(overlay)});
    expect(result).toMatchObject({ok:false,terminationReason:'cancelled'});
    expect(() => readFileSync(marker)).toThrow();
  });
  it('does not trust a source login changed after a formerly valid read', async () => {
    const binding = await refreshDevinCliExecutionBinding('swe-2-high',options());
    chmodSync(credentials,0o666);
    expect(devinCliBindingCurrent(binding,'swe-2-high',NOW)).toBe(false);
    expect(peekDevinCliExecutionBinding('swe-2-high',NOW)).toBeNull();
  });
  it('admits all unique native Free models with one shared auth/catalog/auth tuple and no fabricated windows', async () => {
    const rows = catalog() + '  free-flash  Free Flash  [128K context, Free]\n  paid  Paid  [262K context, $2 / 1M Input]\n  unknown  Unknown  [262K context]\n  no-context  Incomplete  [Free]\n';
    const run = vi.fn(async (_bin:string,args:readonly string[]) => args[0] === 'auth' ? STATUS : rows);
    vi.stubEnv('XDG_DATA_HOME', dirnameTwice(credentials));
    const [first, joined] = await Promise.all([refreshDevinCliExecutionBindings(options(run)),refreshDevinCliExecutionBindings(options(run))]);
    expect(first).toBe(joined);
    expect(first.map(binding => binding.model)).toEqual(['swe-2-high','free-flash']);
    expect(run.mock.calls.map(call => call[1])).toEqual([['auth','status'],['models','list'],['auth','status']]);
    expect(new Set(first.map(binding => [binding.principalDigest,binding.teamDigest,binding.originDigest,binding.executableEpoch,binding.credentialsEpoch,binding.observedAt,binding.validUntil].join(':'))).size).toBe(1);
    for (const binding of first) {
      expect(peekDevinCliExecutionBinding(binding.model,NOW)).toBe(binding);
      expect(devinCliBindingCurrent(binding,binding.model,NOW+60_000)).toBe(false);
      expect(binding).not.toHaveProperty('windows');
    }
    expect(await refreshDevinCliExecutionBindings(options(run))).toBe(first);
    expect(await refreshDevinCliExecutionBinding('free-flash',options(run))).toBe(first[1]);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it('serializes discovery and forced single-model renewal so older Free evidence cannot overwrite a newer denial', async () => {
    vi.stubEnv('XDG_DATA_HOME', dirnameTwice(credentials));
    let release!:()=>void, reached!:()=>void, authReads=0;
    const held=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{reached=resolve;});
    const oldRun=vi.fn(async(_bin:string,args:readonly string[])=>{
      if(args[0]==='auth'){if(++authReads===2){reached();await held;}return STATUS;}
      return catalog();
    });
    const old=refreshDevinCliExecutionBindings(options(oldRun));await ready;
    const paidRun=vi.fn(async(_bin:string,args:readonly string[])=>args[0]==='auth'?STATUS:catalog('262K context, $2 / 1M Input'));
    let settled=false;
    const renewing=refreshDevinCliExecutionBinding('swe-2-high',{...options(paidRun),forceRefresh:true}).finally(()=>{settled=true;});
    await new Promise<void>(resolve=>setImmediate(resolve));
    const contactedBeforeOlderFinished=paidRun.mock.calls.length,settledBeforeOlderFinished=settled;
    release();const [discovered,joined]=await Promise.all([old,renewing]);
    expect({contactedBeforeOlderFinished,settledBeforeOlderFinished,newerDeniedBeforeOlderFinished:settledBeforeOlderFinished && joined===null,
      selectableFreeAfterBoth:peekDevinCliExecutionBinding('swe-2-high',NOW)!==null}).toEqual({contactedBeforeOlderFinished:0,
      settledBeforeOlderFinished:false,newerDeniedBeforeOlderFinished:false,selectableFreeAfterBoth:true});
    expect(joined).toBe(discovered[0]);expect(oldRun).toHaveBeenCalledTimes(3);
    expect(await refreshDevinCliExecutionBinding('swe-2-high',{...options(paidRun),forceRefresh:true})).toBeNull();
    expect(paidRun).toHaveBeenCalledTimes(3);expect(peekDevinCliExecutionBinding('swe-2-high',NOW)).toBeNull();
    // The older flight has finished; no deferred publisher remains to resurrect it.
    await new Promise<void>(resolve=>setImmediate(resolve));expect(peekDevinCliExecutionBinding('swe-2-high',NOW)).toBeNull();
  });
  it('retires previously Free tuple evidence when a fresh catalog reports paid or unavailable models', async () => {
    vi.stubEnv('XDG_DATA_HOME', dirnameTwice(credentials));
    let rows=catalog();
    const run=vi.fn(async (_bin:string,args:readonly string[])=>args[0]==='auth'?STATUS:rows);
    expect(await refreshDevinCliExecutionBindings(options(run))).toHaveLength(1);
    expect(peekDevinCliExecutionBinding('swe-2-high',NOW)).not.toBeNull();
    rows=catalog('262K context, $2 / 1M Input');
    expect(await refreshDevinCliExecutionBinding('swe-2-high',{...options(run),forceRefresh:true})).toBeNull();
    expect(peekDevinCliExecutionBinding('swe-2-high',NOW)).toBeNull();
    expect(await refreshDevinCliExecutionBindings({...options(run),forceRefresh:true})).toEqual([]);
  });
  it('excludes every contradictory duplicate ID without hiding other exact native Free rows', async () => {
    const rows = catalog() + '  swe-2-high  Paid duplicate  [262K context, $2 / 1M Input]\n  free-flash  Free Flash  [128K context, Free]\n';
    const run = vi.fn(async (_bin:string,args:readonly string[]) => args[0] === 'auth' ? STATUS : rows);
    expect((await refreshDevinCliExecutionBindings(options(run))).map(binding=>binding.model)).toEqual(['free-flash']);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it.each(['principal','credentials','executable','revoked'])('refuses the entire native catalog tuple after %s drift', async kind => {
    let authReads=0, allowed=true;
    const run=vi.fn(async (_bin:string,args:readonly string[])=>{
      if(args[0] !== 'auth') {
        if(kind==='credentials')writeFileSync(credentials,'changed private fixture',{mode:0o600});
        if(kind==='executable')writeFileSync(bin,'#!/bin/sh\nexit 1\n# drifted\n',{mode:0o755});
        if(kind==='revoked')allowed=false;
        return catalog();
      }
      return ++authReads===2 && kind==='principal' ? STATUS.replace('native-user-1','native-user-2') : STATUS;
    });
    expect(await refreshDevinCliExecutionBindings({...options(run),admitted:()=>allowed})).toEqual([]);
  });

});

function dirnameTwice(file: string): string { return join(file,'..','..'); }

// Windows cannot supply this POSIX private-file/exec proof; autonomous confinement
// remains unsupported there. Refusal must precede any native account metadata.
it.runIf(process.platform === 'win32')('holds unqualified Windows native file permissions before metadata contact', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'devin-windows-held-')));
  try {
    const bin = join(root,'devin.exe');writeFileSync(bin,'fake native',{mode:0o755});
    mkdirSync(join(root,'data','devin'),{recursive:true});
    const credentialsPath = join(root,'data','devin','credentials.toml');writeFileSync(credentialsPath,'fake login',{mode:0o600});
    const runMetadata = vi.fn(async () => STATUS);
    expect(await refreshDevinCliExecutionBinding('swe-2-high',{cliPath:bin,credentialsPath,runMetadata})).toBeNull();
    expect(runMetadata).not.toHaveBeenCalled();
  } finally {resetDevinCliAdmissionForTest();rmSync(root,{recursive:true,force:true});}
});
