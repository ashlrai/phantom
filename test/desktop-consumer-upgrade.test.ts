/** Original signed bytes and real shared filesystem transaction; macOS and network ports are inert. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {Header} from 'tar';
import {canonicalJson} from '../src/core/authority/canonical-json.js';
import {authoritySurfaceDigest} from '../src/core/authority/surface.js';
import {acquireResourceQuotaRefreshLease} from '../src/core/resources/quota-refresh-lease.js';
import * as bootIdentity from '../src/core/resources/native-boot-identity.js';
import {canonical, digest} from '../src/core/universe/artifacts.js';
import {consumeDesktopUpdateResume, extractSignedAppArchive, type DesktopUpdateDependencies} from '../src/core/desktop/qualified-update.js';
import {desktopUpdateInterlockPath} from '../src/core/desktop/update-interlock.js';
import {buildDefaultGrantPayload, standingGrantEnvelopeDigest} from '../src/core/authority/standing-grant.js';
import type {SignedDesktopUpdateApproval} from '../src/core/authority/custody-client.js';
import type {ConsumerApprovalAuthority} from '../src/core/desktop/consumer-approval.js';
import {consumerInstallerOsCommand,type ConsumerInstallDependencies,type ConsumerTransaction} from '../src/core/desktop/consumer-install.js';
import {cmdDesktop,parseDesktopInstallArgs} from '../src/cli/desktop.js';
import type {CompatibleUpdateManifest,UpdateTrust} from '../src/core/desktop/update-manifest.js';
const transaction=await import('../scripts/local-app-transaction.mjs' as string);
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const {publicKey,privateKey}=generateKeyPairSync('ed25519'),keyId=Buffer.from('0102030405060708','hex');
const publicText=Buffer.from(`untrusted comment: disposable fixture\n${Buffer.concat([Buffer.from('Ed'),keyId,publicKey.export({format:'der',type:'spki'}).subarray(-32)]).toString('base64')}\n`).toString('base64');
function signature(data:Uint8Array) {
  const s=sign(null,createHash('blake2b512').update(data).digest(),privateKey),comment='synthetic consumer fixture';
  return Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from('ED'),keyId,s]).toString('base64')}\ntrusted comment: ${comment}\n${sign(null,Buffer.concat([s,Buffer.from(comment)]),privateKey).toString('base64')}\n`).toString('base64');
}
function archive(rows:{path:string;data:string|Buffer;mode?:number;directory?:boolean}[]) {
  const parts:Buffer[]=[];
  for(const row of rows) {
    const data=Buffer.from(row.data),header=new Header({path:row.path,type:row.directory?'Directory':'File',size:data.length,mode:row.mode??0o644,uid:0,gid:0,mtime:new Date(0)});
    header.encode();parts.push(header.block!,data,Buffer.alloc((512-data.length%512)%512));
  }
  return gzipSync(Buffer.concat([...parts,Buffer.alloc(1024)]));
}
function write(path:string,data:string|Buffer,mode=0o600) {fs.mkdirSync(dirname(path),{recursive:true,mode:0o700});fs.writeFileSync(path,data,{mode});fs.chmodSync(path,mode);}
function installFixture(version='3.30.35') {
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'consumer-install-')));fs.chmodSync(root,0o700);roots.push(root);
  const home=join(root,'home'),applications=join(root,'Applications');for(const dir of [home,applications])fs.mkdirSync(dir,{mode:0o700});
  const revision='b'.repeat(40),tree='c'.repeat(40),code=Buffer.from('throw new Error("fixture never executes candidate code");');
  const core={v:1 as const,roots:['dist/core/authority/fixture.js'],missingRoots:[],files:[{path:'dist/core/authority/fixture.js',sha256:sha(code),bytes:code.length}],packages:[],unresolved:[]};
  const surface={...core,digest:authoritySurfaceDigest(core)},launcher=fs.readFileSync(resolve(import.meta.dirname,'../bin/ashlr'));
  const cli=archive([
    {path:'package/package.json',data:JSON.stringify({name:'@ashlr/phantom',version,type:'module',bin:{ashlr:'bin/ashlr',phm:'bin/ashlr'}})},
    {path:'package/bin/ashlr',data:launcher,mode:0o755},
    {path:'package/dist/build-identity.json',data:JSON.stringify({schemaVersion:1,packageVersion:version,revision,dirty:false,provenance:'git'})},
    {path:'package/dist/cli/index.js',data:code},{path:'package/dist/core/universe/index.js',data:code},
    {path:'package/dist/core/authority/fixture.js',data:code},{path:'package/dist/authority-surface.json',data:JSON.stringify(surface)}]);
  const artifact=(filename:string,data:Buffer)=>({filename,url:`https://github.com/ashlrai/phantom/releases/download/v${version}/${filename}`,bytes:data.length,sha256:sha(data),signature:signature(data)});
  const manifest={schemaVersion:2,kind:'phantom-paired-release',channel:'stable',platform:'darwin-aarch64',version,
    repository:{nameWithOwner:'ashlrai/phantom',repositoryId:1263526319,repositoryNodeId:'R_kgDOS0_hrw',ownerId:258113726,ownerLogin:'ashlrai',defaultBranch:'master'},source:{revision,tree},authoritySurfaceDigest:surface.digest,
    cli:{...artifact(`ashlr-phantom-${version}.tgz`,cli),packageName:'@ashlr/phantom',binName:'ashlr'},
    app:{...artifact(`Phantom_${version}_aarch64.app.tar.gz`,Buffer.from('pending')),bundleIdentifier:'ai.ashlr.desktop',executable:'ashlr-desktop',inventorySha256:'e'.repeat(64),signer:'F'.repeat(40)},
    qualification:{manifestSha256:'0'.repeat(64),archiveSha256:'1'.repeat(64),packageSha256:sha(cli),qualificationSha256:'2'.repeat(64),producer:{runId:10,runAttempt:1,eventSha:revision},attestor:{revision:'a'.repeat(40),runId:20,runAttempt:1},audit:{revision,runId:30,runAttempt:1}}} as CompatibleUpdateManifest;
  const marker=canonicalJson({schemaVersion:1,version,source:manifest.source,authoritySurfaceDigest:surface.digest,packageSha256:sha(cli)});
  const app=archive([
    ...['Phantom.app','Phantom.app/Contents','Phantom.app/Contents/MacOS','Phantom.app/Contents/Resources'].map(path=>({path,data:'',directory:true,mode:0o755})),
    {path:'Phantom.app/Contents/Info.plist',data:JSON.stringify({CFBundleName:'Phantom',CFBundleDisplayName:'Phantom',CFBundleIdentifier:'ai.ashlr.desktop',CFBundleExecutable:'ashlr-desktop',CFBundleShortVersionString:version,CFBundleVersion:version})},
    {path:'Phantom.app/Contents/MacOS/ashlr-desktop',data:code,mode:0o755},{path:'Phantom.app/Contents/MacOS/ashlr',data:code,mode:0o755},
    {path:'Phantom.app/Contents/Resources/phantom-release.json',data:marker}]);
  Object.assign(manifest.app,artifact(manifest.app.filename,app));
  const source=join(root,'source');fs.mkdirSync(source,{mode:0o700});const appRoot=extractSignedAppArchive(app,source);
  const base=transaction.createLocalAppTransactionIo({packageRoot:resolve(import.meta.dirname,'..'),home});manifest.app.inventorySha256=base.appInventory(appRoot);
  const trust:UpdateTrust={publicKey:publicText,repository:{fullName:'ashlrai/phantom',repositoryId:1263526319,repositoryNodeId:'R_kgDOS0_hrw',ownerLogin:'ashlrai',ownerId:258113726,ownerNodeId:'O_kgDOD2KAvg'},channel:'stable',platform:'darwin-aarch64'};
  const published=new Map<string,Buffer>();
  function publish() {const manifestText=canonicalJson(manifest);published.set(`https://github.com/ashlrai/phantom/releases/download/v${version}/latest.json`,Buffer.from(canonicalJson({version,platforms:{'darwin-aarch64':{url:manifest.app.url,signature:manifest.app.signature}},phantom:{manifestText,signature:signature(Buffer.from(manifestText))}})));}
  published.set(manifest.app.url,app);published.set(manifest.cli.url,cli);publish();
  let now=0,live=false,health=true,spawnFailure=false;
  const census={leases:[] as unknown[],unknown:0,reaped:0},mapped=(path:string)=>path.startsWith('/Applications/')?join(applications,path.slice('/Applications/'.length)):path;
  const io={...base,platform:'darwin',clock:()=>now,sleep:async(ms:number)=>{now+=ms;},fetchStatus:vi.fn(async()=>health?200:503),log:vi.fn(),executionLeaseCensus:vi.fn(async()=>census),exclusiveRenamePreflight:vi.fn()};
  for(const name of ['lstat','exists','appInventory','readBoundedFile']) {const fn=base[name].bind(base);io[name]=(path:string,...args:unknown[])=>fn(mapped(path),...args);}
  io.makeInstallStage=()=>'/Applications/'+basename(fs.mkdtempSync(join(applications,'.phantom-install-')));
  io.writeInstallJournal=vi.fn((owner:string,value:unknown)=>write(join(mapped(owner),'transaction.json'),JSON.stringify(value)));
  io.renameExclusive=vi.fn((from:string,to:string,expected:{dev:number;ino:number})=> {const s=fs.lstatSync(mapped(from));expect([s.dev,s.ino]).toEqual([expected.dev,expected.ino]);expect(fs.existsSync(mapped(to))).toBe(false);fs.renameSync(mapped(from),mapped(to));});
  io.removeInstallTree=(path:string,owner:string)=> {expect(dirname(path)).toBe(owner);fs.rmSync(mapped(path),{recursive:true,force:true});};
  io.exec=vi.fn((bin:string,args:string[])=> {
    expect(consumerInstallerOsCommand(bin,args)).toBe(true);
    if(bin==='/usr/bin/plutil')return {status:0,stdout:JSON.parse(fs.readFileSync(mapped(args.at(-1)!),'utf8'))[args[1]]+'\n'};
    if(bin==='/usr/bin/codesign') {expect(args[0]).toBe('--verify');expect(args[3]).toContain(manifest.app.signer);return {status:0,stdout:''};}
    if(bin==='/usr/bin/ditto') {
      const [from,to]=args.slice(-2).map(mapped);
      if(args[0]==='-c')fs.cpSync(from,join(to,basename(from)),{recursive:true,preserveTimestamps:true});
      else fs.cpSync(from,to,{recursive:true,preserveTimestamps:true});
      return {status:0,stdout:''};
    }
    if(bin==='/usr/bin/open') {if(spawnFailure)return {status:1,stdout:''};live=true;write(join(home,'.ashlr/.desktop-sidecar.json'),JSON.stringify({desktopPid:100,sidecarPid:101,port:7777,sidecarPath:'/Applications/Phantom.app/Contents/MacOS/ashlr'}));return {status:0,stdout:''};}
    if(bin==='/bin/ps')return {status:0,stdout:live?'100 1 Thu Oct 8 00:00:00 2026 /Applications/Phantom.app/Contents/MacOS/ashlr-desktop\n101 100 Thu Oct 8 00:00:00 2026 /Applications/Phantom.app/Contents/MacOS/ashlr verse --port 7777 --no-open --json\n':''};
    if(bin==='/usr/sbin/lsof')return {status:0,stdout:health?'p101\nf8\n':'p999\nf8\n'};
    throw new Error('unexpected OS port');
  });
  write(join(home,'.ashlr/KILL'),'');
  const helper={...transaction,createLocalAppTransactionIo:vi.fn(()=>io)} as ConsumerTransaction;
  const deps:ConsumerInstallDependencies={home,platform:'darwin',architecture:'arm64',packageRoot:resolve(import.meta.dirname,'..'),version,revision,authoritySurfaceDigest:surface.digest,trust,
    assertRunning:vi.fn(),download:vi.fn(async(url)=>{const bytes=published.get(url);if(!bytes)throw new Error('unpublished fixture');return Buffer.from(bytes);}),
    transaction:vi.fn(async()=>helper),readManagedVersion:vi.fn(async()=>version),discover:vi.fn(async managed=>(['phm','ashlr'] as const).map(name=>({name,target:managed,version,versionSource:'executed-managed' as const})))};
  const current=join(home,'.local/share/ashlr/current');
  return {root,home,applications,version,manifest,published,publish,deps,helper,io,census,current,appRoot,surface,code,setLive:(value:boolean)=>{live=value;},setHealth:(value:boolean)=>{health=value;},failOpen:()=>{spawnFailure=true;}};
}

import {applyConsumerDesktopUpgrade,approveConsumerDesktopUpdate,inspectConsumerDesktopUpgrade,retryApprovedConsumerDesktopUpdate,
  type ConsumerUpgradeDependencies} from '../src/core/desktop/consumer-upgrade.js';
function fixture(version='3.30.35') {
  const f=installFixture(version),old=join(f.home,'.local/share/ashlr/releases','a'.repeat(40));
  const packageRoot=join(f.root,'running');write(join(packageRoot,'bin/ashlr'),fs.readFileSync(resolve(import.meta.dirname,'../bin/ashlr')),0o755);
  write(join(old,'package.json'),JSON.stringify({name:'@ashlr/phantom',version:'3.30.24'}));
  write(join(old,'bin/ashlr'),fs.readFileSync(resolve(import.meta.dirname,'fixtures/ashlr-3.30.24')),0o755);
  fs.symlinkSync(old,f.current);fs.mkdirSync(join(f.home,'.local/bin'),{recursive:true,mode:0o700});
  for(const name of ['ashlr','phm'])fs.symlinkSync(join(f.current,'bin/ashlr'),join(f.home,'.local/bin',name));
  f.published.set('https://github.com/ashlrai/phantom/releases/latest/download/latest.json',f.published.get(`https://github.com/ashlrai/phantom/releases/download/v${version}/latest.json`)!);
  const deps:ConsumerUpgradeDependencies={...f.deps,packageRoot,smokeVersion:vi.fn(async launcher=>JSON.parse(fs.readFileSync(join(dirname(dirname(launcher)),'package.json'),'utf8')).version),residentStop:vi.fn(async()=>{expect(fs.realpathSync(f.current)).toBe(old);return {ok:true};})};
  return {...f,old,deps};
}
const options={mode:'upgrade' as const,apply:false,requireApp:false};
function oldApp(f:ReturnType<typeof fixture>):string {
  const app=join(f.applications,'Phantom.app'),plist=join(app,'Contents/Info.plist');
  fs.cpSync(f.appRoot,app,{recursive:true});
  const info=JSON.parse(fs.readFileSync(plist,'utf8'));info.CFBundleShortVersionString='3.30.24';info.CFBundleVersion='3.30.24';write(plist,JSON.stringify(info),0o644);
  return app;
}
describe.skipIf(process.platform === 'win32')('managed consumer upgrade',()=> {
  function coveredFixture() {
    const f=fixture('3.30.76'), app=oldApp(f), marker=desktopUpdateInterlockPath(f.home);
    write(join(f.old,'package.json'),JSON.stringify({name:'@ashlr/phantom',version:'3.30.75',type:'module',bin:{ashlr:'bin/ashlr'}}));
    write(join(f.old,'dist/build-identity.json'),JSON.stringify({schemaVersion:1,packageVersion:'3.30.75',revision:basename(f.old),dirty:false,provenance:'git'}));
    write(join(f.old,'dist/authority-surface.json'),JSON.stringify(f.surface));
    write(join(f.old,'dist/core/authority/fixture.js'),f.code);
    const plist=join(app,'Contents/Info.plist');
    write(plist,fs.readFileSync(plist,'utf8').replaceAll('3.30.24','3.30.39'),0o644);
    fs.unlinkSync(join(f.home,'.ashlr/KILL'));f.setLive(true);
    const sidecar = join(f.home,'.ashlr/.desktop-sidecar.json');
    write(sidecar,JSON.stringify({desktopPid:100,sidecarPid:101,port:7777,sidecarPath:'/Applications/Phantom.app/Contents/MacOS/ashlr'}));
    let now=Date.now(),queued=true;
    const admission={active:true,stop:false,grantId:'a'.repeat(32),envelopeDigest:'e'.repeat(64),surfaceDigest:f.surface.digest,leaseCount:0,unknownLeases:0,grantState:'active'};
    const queuedWork=vi.fn(()=>queued);
    const resident={previous:{platform:'darwin' as const,homeDir:f.home,binPath:join(f.old,'bin/ashlr')},
      dev:1,ino:2,ctimeMs:3,target:'gui/42/ai.ashlr.daemon',processStart:'Wed Oct 7 12:00:00 2026'};
    const owned:DesktopUpdateDependencies={
      home:f.home,platform:'darwin',architecture:'arm64',packageRoot:f.old,trust:f.deps.trust,admission:()=>admission,
      currentPackageRoot:()=>fs.realpathSync(f.current),captureParent:()=>{throw new Error('native handshake forbidden');},
      verifyParent:async()=>false,parentState:()=> 'unknown',operatorStop:()=>fs.existsSync(join(f.home,'.ashlr/KILL'))?'active':'inactive',
      hostCensus:()=>({state:'supported',activeJobs:0,unknown:0}),queuedWork,now:()=>now,sleep:async(ms)=>{now+=ms;queued=false;},
      download:f.deps.download,transaction:async()=>f.helper as unknown as Awaited<ReturnType<NonNullable<DesktopUpdateDependencies['transaction']>>>,
      ownedResident:()=>({...resident,runtime:fs.existsSync(marker)?{loaded:true}:{loaded:true,pid:42}}),
    };
    const resume=vi.fn<NonNullable<DesktopUpdateDependencies['resumeOwned']>>(async(capability,consume)=>{
      expect(consumeDesktopUpdateResume(capability)).toBeNull();
      const authorized=consume(capability)!;
      expect(consume(capability)).toBeNull();expect(authorized.pid).toBe(42);
      expect(authorized.next.binPath).toBe(join(fs.realpathSync(f.current),'bin/ashlr'));
      expect(authorized.release()).toBe(true);return true;
    });
    owned.resumeOwned=resume;
    const quit=vi.fn((path:string)=>{
      expect(path).toBe('/Applications/Phantom.app'); expect(queued).toBe(false);expect(fs.existsSync(marker)).toBe(false);
      f.setLive(false); fs.unlinkSync(sidecar);return true;
    });
    const post=vi.fn<NonNullable<NonNullable<ConsumerUpgradeDependencies['ownedUpdate']>['post']>>(
      value=>({status:'posted',id:(value as {id:string}).id,cursor:1}));
    f.deps.ownedUpdate={dependencies:owned,quit,post};
    return {...f,app,marker,owned,admission,resume,quit,post,setQueued:(value:boolean)=>{queued=value;}};
  }

  function oneAskFixture(prior:'changed'|'none'|'expired') {
    const f=coveredFixture();
    if (prior==='changed') {
      const oldCode=Buffer.from('previous authority');
      const oldSurface={...f.surface,files:[{...f.surface.files[0]!,sha256:sha(oldCode),bytes:oldCode.length}]};
      oldSurface.digest=authoritySurfaceDigest(oldSurface);
      write(join(f.old,'dist/authority-surface.json'),JSON.stringify(oldSurface));
      write(join(f.old,'dist/core/authority/fixture.js'),oldCode);
      f.admission.surfaceDigest=oldSurface.digest;
    } else {
      f.admission.grantState=prior;
      f.admission.active=false;
    }
    let baseline='previous grant and ledger', signed:SignedDesktopUpdateApproval|undefined;
    const signApproval=vi.fn<ConsumerApprovalAuthority['sign']>(async request=>signed={
      grant:{payload:request.grant,signature:Buffer.alloc(64).toString('base64')}, approvalSignature:Buffer.alloc(64,1).toString('base64'),
    });
    const accept=vi.fn<ConsumerApprovalAuthority['accept']>((request,approval)=>{
      const stage=join(f.home,'.ashlr/updates/consumer-staging',`upgrade-${request.binding.transaction}`);
      expect(JSON.parse(fs.readFileSync(join(stage,'resident-terminal.json'),'utf8')).state).toBe('installed');
      expect(fs.realpathSync(f.current)).toBe(join(dirname(f.old),f.manifest.source.revision));
      expect(JSON.parse(fs.readFileSync(join(f.app,'Contents/Info.plist'),'utf8')).CFBundleShortVersionString).toBe('3.30.76');
      baseline='candidate grant and ledger';
      f.owned.admission=target=>target==='installed' ? {...f.admission,active:true,surfaceDigest:f.surface.digest,
        grantId:approval.grant.payload.grantId,envelopeDigest:standingGrantEnvelopeDigest(approval.grant)} : f.admission;
      return true;
    });
    const draft=vi.fn<ConsumerApprovalAuthority['draft']>(async (surface,now)=>buildDefaultGrantPayload({
      nowMs:now,grantId:'b'.repeat(32),grantSeq:2,keyId:'se-p256-0123456789abcdef',hostBinding:'a'.repeat(64),
      authoritySurfaceDigest:surface,repos:[{nameWithOwner:'ashlrai/fleet-canary',visibility:'public',hasVerify:true}],seats:[],
    }));
    f.deps.ownedUpdate!.authority={draft,sign:signApproval,accept,snapshot:()=>baseline,
      verify(request,approval,now):approval is SignedDesktopUpdateApproval {
        return Boolean(signed && canonicalJson(approval)===canonicalJson(signed) &&
          request.authority===baseline && request.binding.expiresAtMs>now);
      }};
    const events=new Map<string,unknown>();
    f.post.mockImplementation(value=>{
      const {id}=value as {id:string};
      if(events.has(id))return {status:'duplicate',id,cursor:1};
      events.set(id,value);return {status:'posted',id,cursor:1};
    });
    return {...f,draft,signApproval,accept,events,baseline:()=>baseline};
  }

  it.each([
    ['changed','update-surface-changed'],['none','update-grant-missing'],['expired','update-grant-expired'],
  ] as const)('asks once for %s authority, defers work, and consumes approval before installing',async(prior,reason)=>{
    const f=oneAskFixture(prior), opt={...options,requireApp:true};
    const plan=await inspectConsumerDesktopUpgrade(f.deps,opt);
    expect(plan).toMatchObject({state:'held',reason,scheduleHint:'next-low-activity-window',
      ownerAction:{reason,touchId:true,command:expect.stringMatching(/^phm desktop update sign-desktop-update --stage [a-f0-9]{32}$/)}});
    expect(await inspectConsumerDesktopUpgrade(f.deps,opt)).toMatchObject({ownerAction:plan.ownerAction,busAudit:'duplicate'});
    expect(f.draft).toHaveBeenCalledOnce();
    expect(f.draft).toHaveBeenCalledWith(f.surface.digest,expect.any(Number));
    const id=plan.ownerAction!.command.split(' ').at(-1)!;
    expect(await approveConsumerDesktopUpdate(f.deps,id)).toMatchObject({state:'held',scheduleHint:'next-low-activity-window'});
    expect(f.signApproval).toHaveBeenCalledOnce();expect(f.quit).not.toHaveBeenCalled();expect(f.accept).not.toHaveBeenCalled();
    expect((await inspectConsumerDesktopUpgrade(f.deps,opt)).ownerAction).toBeUndefined();
    f.setQueued(false);
    expect(await retryApprovedConsumerDesktopUpdate(f.deps)).toMatchObject({state:'upgraded',authorityResumed:true,applied:true,
      daemon:{restart:{ownerConfirmation:false,coveredBy:{grantId:'b'.repeat(32),transaction:id,surfaceDigest:f.surface.digest}}}});
    expect(f.accept).toHaveBeenCalledOnce();expect(f.resume).toHaveBeenCalledOnce();
    const attempt=join(f.home,'.ashlr/updates/consumer-staging',`upgrade-${id}`,'consumer-attempt.json');
    expect(JSON.parse(fs.readFileSync(attempt,'utf8'))).toMatchObject({approvalDigest:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(await retryApprovedConsumerDesktopUpdate(f.deps,id)).toBeNull();
    await approveConsumerDesktopUpdate(f.deps,id);
    expect(f.signApproval).toHaveBeenCalledOnce();
    expect([...f.events.keys()]).toEqual([`desktop-update:${id}:owner-action`,`desktop-update:${id}:hold`,`desktop-update:${id}:outcome`]);
  });

  it('does not accept the replacement on rollback and consumes the attempt',async()=>{
    const f=oneAskFixture('changed');
    const plan=await inspectConsumerDesktopUpgrade(f.deps,{...options,requireApp:true});
    const id=plan.ownerAction!.command.split(' ').at(-1)!;
    f.setQueued(false);f.failOpen();
    const outcome=await approveConsumerDesktopUpdate(f.deps,id);
    expect(outcome).toMatchObject({state:'held',applied:false,authorityResumed:true,reason:'owned-pause-aborted'});
    expect(f.accept).not.toHaveBeenCalled();expect(f.baseline()).toBe('previous grant and ledger');
    expect(fs.realpathSync(f.current)).toBe(f.old);expect(fs.existsSync(f.marker)).toBe(false);
    expect(await retryApprovedConsumerDesktopUpdate(f.deps,id)).toBeNull();
  });

  it('never starts a previously stopped resident after approving a missing grant',async()=>{
    const f=oneAskFixture('none');
    const resident=f.owned.ownedResident!()!;
    f.owned.ownedResident=()=>({...resident,runtime:{loaded:true}});
    const plan=await inspectConsumerDesktopUpgrade(f.deps,{...options,requireApp:true});
    f.setQueued(false);
    await expect(approveConsumerDesktopUpdate(f.deps,plan.ownerAction!.command.split(' ').at(-1)!))
      .resolves.toMatchObject({state:'upgraded',applied:true,authorityResumed:false});
    expect(f.accept).toHaveBeenCalledOnce();expect(f.resume).not.toHaveBeenCalled();
    expect(fs.existsSync(f.marker)).toBe(false);
  });

  it('plans and applies the Pro paired upgrade without native handoff or owner confirmation', async()=>{
    const f=coveredFixture();
    const plan=await inspectConsumerDesktopUpgrade(f.deps,{...options,requireApp:true});
    expect(plan).toMatchObject({state:'ready',installed:{version:'3.30.75'},candidate:{version:'3.30.76'},
      app:{state:'update-available'},daemon:{restart:{ownerConfirmation:false,touchId:false,coveredBy:{
        grantId:f.admission.grantId,surfaceDigest:f.surface.digest,transaction:expect.stringMatching(/^[a-f0-9]{32}$/),
      }}}});
    expect(f.quit).not.toHaveBeenCalled();
    expect(await applyConsumerDesktopUpgrade(plan)).toMatchObject({state:'upgraded',applied:true,authorityResumed:true,busAudit:'posted',
      daemon:{restart:{performed:true,ownerConfirmation:false,coveredBy:plan.daemon.restart.coveredBy}}});
    expect(f.quit).toHaveBeenCalledOnce(); expect(f.resume).toHaveBeenCalledOnce(); expect(f.post).toHaveBeenCalledOnce();
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({body:expect.objectContaining({kind:'desktop.update.resume'})}));
    expect(f.deps.residentStop).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(join(f.app,'Contents/Info.plist'),'utf8')).CFBundleShortVersionString).toBe('3.30.76');
    expect(fs.realpathSync(f.current)).toBe(join(dirname(f.old),f.manifest.source.revision));
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(fs.existsSync(join(f.home,'.ashlr/KILL'))).toBe(false);
    const {transaction:stage}=plan.daemon.restart.coveredBy!;
    expect(fs.existsSync(join(f.home,'.ashlr/updates/consumer-staging',`upgrade-${stage}`,'consumer-attempt.json'))).toBe(true);
    expect(await applyConsumerDesktopUpgrade(plan)).toMatchObject({state:'held',reason:'inspection-required'});
    expect(f.post).toHaveBeenCalledOnce();
  });

  it('does not quit or hold Stop when authority changes after the covered plan',async()=>{
    const f=coveredFixture();
    const plan=await inspectConsumerDesktopUpgrade(f.deps,{...options,requireApp:true});
    expect(plan.state).toBe('ready');
    f.admission.envelopeDigest='f'.repeat(64);
    expect(await applyConsumerDesktopUpgrade(plan)).toMatchObject({state:'held',reason:'resume-grant-changed',authorityResumed:false});
    expect(f.quit).not.toHaveBeenCalled();expect(fs.existsSync(f.marker)).toBe(false);
    expect(f.post).toHaveBeenCalledOnce();
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({body:expect.objectContaining({kind:'desktop.update.hold',reason:'resume-grant-changed'})}));
  });

  it('keeps the manual Stop plan for a host with an older dispatcher',async()=>{
    const f=coveredFixture();
    f.owned.hostCensus=()=>({state:'unsupported',activeJobs:0,unknown:1});
    expect(await inspectConsumerDesktopUpgrade(f.deps,{...options,requireApp:true})).toMatchObject({
      state:'ready',daemon:{restart:{ownerConfirmation:true,reason:'drain-interlock-unsupported'}},
    });
    expect(f.quit).not.toHaveBeenCalled();
  });

  it('holds on a refused normal quit and leaves a fresh upgrade eligible',async()=>{
    const f=coveredFixture(), opt={...options,requireApp:true};
    f.quit.mockReturnValueOnce(false);
    const plan=await inspectConsumerDesktopUpgrade(f.deps,opt);
    expect(await applyConsumerDesktopUpgrade(plan)).toMatchObject({state:'held',reason:'app-quit-unverified',applied:false});
    expect(fs.realpathSync(f.current)).toBe(f.old);
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(fs.existsSync(join(dirname(f.old),f.manifest.source.revision))).toBe(false);
    expect(await inspectConsumerDesktopUpgrade(f.deps,opt)).toMatchObject({state:'ready'});
  });
  it('does not claim already-current with an absent required app',async()=> {
    const f=fixture('3.30.24');
    expect(await inspectConsumerDesktopUpgrade(f.deps,{...options,requireApp:true})).toMatchObject({state:'held',reason:'app-needs-owner',app:{state:'absent'}});
  });
  it('replaces the verified native app as part of the managed CLI switch',async()=> {
    const f=fixture();oldApp(f);
    const inspected=await inspectConsumerDesktopUpgrade(f.deps,{...options,requireApp:true});
    expect(await applyConsumerDesktopUpgrade(inspected)).toMatchObject({state:'upgraded',app:{state:'current'},authorityResumed:false});
    expect(f.io.appInventory('/Applications/Phantom.app')).toBe(f.manifest.app.inventorySha256);
    expect(fs.readlinkSync(f.current)).toBe(join(dirname(f.old),f.manifest.source.revision));
  });
  it('repairs an older app without changing the verified current CLI pointer',async()=> {
    const f=fixture();
    expect(await applyConsumerDesktopUpgrade(await inspectConsumerDesktopUpgrade(f.deps,options))).toMatchObject({state:'upgraded'});
    const before=fs.lstatSync(f.current);oldApp(f);f.deps.residentStop=async()=>({ok:true});
    const inspected=await inspectConsumerDesktopUpgrade(f.deps,{...options,requireApp:true});
    expect(await applyConsumerDesktopUpgrade(inspected)).toMatchObject({state:'upgraded',app:{state:'current'}});
    expect(fs.lstatSync(f.current).ino).toBe(before.ino);
  });
  it('restores both members after the replacement app fails to launch',async()=> {
    const f=fixture();oldApp(f);const inventory=f.io.appInventory('/Applications/Phantom.app');f.failOpen();
    const inspected=await inspectConsumerDesktopUpgrade(f.deps,{...options,requireApp:true});
    expect(await applyConsumerDesktopUpgrade(inspected)).toMatchObject({state:'rolled-back',applied:false});
    expect(fs.readlinkSync(f.current)).toBe(f.old);
    expect(f.io.appInventory('/Applications/Phantom.app')).toBe(inventory);
  });
  it.each([false,true])('recovers a proven same-boot dead collector before quiescence on apply (paired app: %s)',async paired=> {
    const f=fixture(),ledger=join(f.home,'.ashlr/account-connections/ledger');
    if(paired)oldApp(f);
    fs.mkdirSync(ledger,{recursive:true,mode:0o700});
    vi.spyOn(bootIdentity,'readNativeBootIdentity').mockReturnValue({machineDigest:'a'.repeat(64),bootId:'11111111-2222-3333-4444-555555555555'});
    const lease=await acquireResourceQuotaRefreshLease(ledger,{scope:'native-connection-metadata',trackNativeActivity:true});
    lease.markPending();lease.close(true);
    const pending=join(ledger,'.resource-quota-refresh-pending.json'),activity=join(ledger,'.resource-quota-refresh-activity.json');
    const record=JSON.parse(fs.readFileSync(pending,'utf8')),pid=2147483000;
    record.ownerPid=pid;write(pending,canonical(record)+'\n');
    write(activity,canonical({...JSON.parse(fs.readFileSync(activity,'utf8')),markerDigest:digest(canonical(record))})+'\n');
    const kill=process.kill;
    vi.spyOn(process,'kill').mockImplementation((target,signal)=>{
      if(target===pid)throw Object.assign(new Error('fixture owner absent'),{code:'ESRCH'});
      return kill(target,signal);
    });
    const emit=vi.fn();
    expect(await cmdDesktop(['install','--upgrade','--apply'],undefined,emit,undefined,f.deps)).toBe(0);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({state:'upgraded'}));
    if(paired)expect(emit).toHaveBeenCalledWith(expect.objectContaining({app:{state:'current',reason:null}}));
    expect(fs.existsSync(pending)).toBe(false);
  });
  it('reports a fixed hold if a quota marker appears at the paired app transaction boundary',async()=> {
    const f=fixture();oldApp(f);
    const inspected=await inspectConsumerDesktopUpgrade(f.deps,options);
    const pending=join(f.home,'.ashlr/account-connections/ledger/.resource-quota-refresh-pending.json');
    vi.mocked(f.deps.residentStop).mockImplementationOnce(async()=> {
      f.io.executionLeaseCensus.mockImplementationOnce(async()=>{
        f.io.executionLeaseCensus.mockImplementationOnce(async()=>{write(pending,'{}');return f.census;});
        return f.census;
      });
      return {ok:true};
    });
    expect(await applyConsumerDesktopUpgrade(inspected)).toMatchObject({state:'held',reason:'collector-pending',stop:{reason:'collector-pending',drained:false},remedyCommand:expect.any(String)});
    expect(fs.readlinkSync(f.current)).toBe(f.old);
    expect(fs.readFileSync(pending,'utf8')).toBe('{}');
  });
  it('reports the exact private path in inspection and tightens it only on explicit apply',async()=> {
    const f=fixture(),local=join(f.home,'.local'),share=join(local,'share');
    fs.mkdirSync(share,{recursive:true,mode:0o700});
    fs.chmodSync(local,0o755);fs.chmodSync(share,0o751);
    expect(await inspectConsumerDesktopUpgrade(f.deps,options)).toMatchObject({state:'held',reason:'unsafe-local-path',path:local,remedyCommand:`chmod go-rwx '${local}'`});
    expect(fs.statSync(local).mode&0o777).toBe(0o755);
    const emit=vi.fn();
    expect(await cmdDesktop(['install','--upgrade','--apply'],undefined,emit,undefined,f.deps)).toBe(0);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({state:'upgraded',tightenedPaths:[local,share]}));
    expect(fs.statSync(local).mode&0o777).toBe(0o700);
    expect(fs.statSync(share).mode&0o777).toBe(0o700);
  });
  it('holds an unproven collector marker and provides a remedy command',async()=> {
    const f=fixture(),pending=join(f.home,'.ashlr/account-connections/ledger/.resource-quota-refresh-pending.json');
    write(pending,'{}');
    const emit=vi.fn(),code=await cmdDesktop(['install','--upgrade','--apply'],undefined,emit,undefined,f.deps);
    expect(code).toBe(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({state:'held',reason:'collector-pending',remedyCommand:expect.any(String)}));
    expect(fs.readFileSync(pending,'utf8')).toBe('{}');
  });
  it('inspects without mutation then upgrades once, retaining previous and writing a private journal',async()=> {
    const f=fixture(),before=fs.readlinkSync(f.current),r=await inspectConsumerDesktopUpgrade(f.deps,options);
    expect(r).toMatchObject({state:'ready',installed:{version:'3.30.24'},candidate:{version:'3.30.35'},stop:{engaged:true,drained:true}});
    expect(Object.isFrozen(r)).toBe(true);expect(fs.readlinkSync(f.current)).toBe(before);expect(f.deps.residentStop).not.toHaveBeenCalled();
    expect(fs.existsSync(join(f.home,'.local/share/ashlr/upgrade.json'))).toBe(false);
    expect(JSON.stringify(r)).not.toContain(f.root);expect(JSON.stringify(r)).not.toContain(f.home);
    const applied=await applyConsumerDesktopUpgrade(r);
    expect(applied).toMatchObject({state:'upgraded',applied:true,daemon:{stop:{performed:true},restart:{performed:false,ownerConfirmation:true}}});
    expect(f.deps.residentStop).toHaveBeenCalledTimes(1);expect(fs.realpathSync(f.current)).toBe(join(dirname(f.old),f.manifest.source.revision));expect(fs.existsSync(f.old)).toBe(true);
    expect(fs.readFileSync(join(f.current,'bin/ashlr'))).toEqual(fs.readFileSync(resolve(import.meta.dirname,'../bin/ashlr')));
    const journal=join(f.home,'.local/share/ashlr/upgrade.json');
    expect(fs.statSync(journal).mode&0o777).toBe(0o600);expect(JSON.parse(fs.readFileSync(journal,'utf8'))).toMatchObject({schema:'desktop-upgrade-journal.v1',previous:{version:'3.30.24'},current:{version:'3.30.35'}});
    expect(await applyConsumerDesktopUpgrade(r)).toMatchObject({state:'held',reason:'inspection-required'});
    expect(await applyConsumerDesktopUpgrade(JSON.parse(JSON.stringify(r)))).toMatchObject({state:'held',reason:'inspection-required'});
    expect(JSON.stringify(applied)).not.toContain(f.root);expect(fs.readdirSync(f.applications)).toEqual([]);
  });
  it.each([['3.30.23','held','downgrade-refused'],['3.30.24','current','already-current']])('compares candidate %s numerically',async(version,state,reason)=> {
    const f=fixture(version);expect(await inspectConsumerDesktopUpgrade(f.deps,options)).toMatchObject({state,reason});expect(f.deps.residentStop).not.toHaveBeenCalled();
  });
  it.each(['missing','links','current'])('refuses unmanaged %s',async kind=> {
    const f=fixture();
    if(kind==='missing')fs.unlinkSync(f.current);
    if(kind==='links'){fs.unlinkSync(join(f.home,'.local/bin/phm'));fs.symlinkSync('/absent',join(f.home,'.local/bin/phm'));}
    if(kind==='current'){fs.unlinkSync(f.current);fs.symlinkSync(f.home,f.current);}
    expect(await inspectConsumerDesktopUpgrade(f.deps,options)).toMatchObject({state:'held',reason:kind==='missing'?'not-installed':kind==='links'?'unmanaged-links':'unmanaged-current'});
  });
  it('preserves shared install guard reasons during inspection',async()=> {
    const f=fixture();fs.chmodSync(join(f.home,'.local/share'),0o755);
    expect(await inspectConsumerDesktopUpgrade(f.deps,options)).toMatchObject({state:'held',reason:'unsafe-local-path'});
    expect(f.deps.residentStop).not.toHaveBeenCalled();
  });
  it('tightens owned release parents that become public between inspection and apply',async()=> {
    const f=fixture(),r=await inspectConsumerDesktopUpgrade(f.deps,options);
    const share=join(f.home,'.local/share');fs.chmodSync(share,0o755);
    expect(await applyConsumerDesktopUpgrade(r)).toMatchObject({state:'upgraded',tightenedPaths:[share]});
    expect(fs.statSync(share).mode&0o777).toBe(0o700);
  });
  it('keeps unexpected inspection errors generic',async()=> {
    const f=fixture();vi.mocked(f.deps.transaction).mockRejectedValue(new Error('unexpected transaction error'));
    expect(await inspectConsumerDesktopUpgrade(f.deps,options)).toMatchObject({state:'held',reason:'inspection-unavailable'});
  });
  it('removes only its newly created release when pre-switch smoke fails',async()=> {
    const f=fixture(),r=await inspectConsumerDesktopUpgrade(f.deps,options);vi.mocked(f.deps.smokeVersion).mockResolvedValue(null);
    expect(await applyConsumerDesktopUpgrade(r)).toMatchObject({state:'held',reason:'smoke-failed'});
    expect(fs.realpathSync(f.current)).toBe(f.old);expect(fs.existsSync(join(dirname(f.old),f.manifest.source.revision))).toBe(false);expect(f.deps.residentStop).not.toHaveBeenCalled();
  });
  it('restores the pointer on a failed post-switch smoke',async()=> {
    const f=fixture(),r=await inspectConsumerDesktopUpgrade(f.deps,options);vi.mocked(f.deps.smokeVersion).mockResolvedValueOnce('3.30.35').mockResolvedValueOnce(null);
    expect(await applyConsumerDesktopUpgrade(r)).toMatchObject({state:'rolled-back',reason:'post-switch-smoke',applied:false});expect(fs.realpathSync(f.current)).toBe(f.old);
    expect(f.io.readCurrentPointer(f.current)?.target).toBe(f.old);
  });
  it.each(['smoke','journal'])('reports rollback-held when restoration after %s failure is refused',async kind=> {
    const f=fixture(),r=await inspectConsumerDesktopUpgrade(f.deps,options);
    f.io.restoreCurrentPointer=vi.fn(()=>{throw new Error('pointer ownership uncertain');});
    if(kind==='smoke')vi.mocked(f.deps.smokeVersion).mockResolvedValueOnce('3.30.35').mockResolvedValueOnce(null);
    else fs.mkdirSync(join(f.home,'.local/share/ashlr/upgrade.json'),{mode:0o700});
    expect(await applyConsumerDesktopUpgrade(r)).toMatchObject({state:'held',reason:'rollback-held',applied:false});
    expect(f.io.restoreCurrentPointer).toHaveBeenCalledTimes(1);
    expect(fs.realpathSync(f.current)).toBe(join(dirname(f.old),f.manifest.source.revision));
  });
  it('rolls back using the journal and refuses a changed current pointer',async()=> {
    const f=fixture();expect((await applyConsumerDesktopUpgrade(await inspectConsumerDesktopUpgrade(f.deps,options))).state).toBe('upgraded');
    vi.mocked(f.deps.residentStop).mockResolvedValue({ok:true});
    const journalPath=join(f.home,'.local/share/ashlr/upgrade.json'),saved=JSON.parse(fs.readFileSync(journalPath,'utf8'));saved.previous.extra=f.home;write(journalPath,JSON.stringify(saved));
    const r=await inspectConsumerDesktopUpgrade(f.deps,{...options,mode:'rollback'});
    expect(r).toMatchObject({state:'ready',candidate:{version:'3.30.24'}});
    expect(JSON.stringify(r)).not.toContain(f.home);
    expect(await applyConsumerDesktopUpgrade(r)).toMatchObject({state:'reverted',applied:true});expect(fs.realpathSync(f.current)).toBe(f.old);
    expect(fs.readFileSync(join(f.current,'bin/ashlr'))).toEqual(fs.readFileSync(resolve(import.meta.dirname,'fixtures/ashlr-3.30.24')));
    expect(f.io.readCurrentPointer(f.current)?.target).toBe(f.old);
    const journal=JSON.parse(fs.readFileSync(join(f.home,'.local/share/ashlr/upgrade.json'),'utf8'));expect(journal.current.version).toBe('3.30.24');
    fs.unlinkSync(f.current);fs.symlinkSync(join(dirname(f.old),f.manifest.source.revision),f.current);
    expect(await inspectConsumerDesktopUpgrade(f.deps,{...options,mode:'rollback'})).toMatchObject({state:'held',reason:'current-changed'});
  });
  it('refuses rollback to a launcher outside canonical history',async()=> {
    const f=fixture();expect((await applyConsumerDesktopUpgrade(await inspectConsumerDesktopUpgrade(f.deps,options))).state).toBe('upgraded');
    write(join(f.old,'bin/ashlr'),'unlisted launcher',0o755);
    const r=await inspectConsumerDesktopUpgrade(f.deps,{...options,mode:'rollback'});
    expect(r).toMatchObject({state:'held',reason:'launcher-identity'});
  });
  it('holds on an ad-hoc app rather than splitting the app and CLI',async()=> {
    const f=fixture();fs.cpSync(f.appRoot,join(f.applications,'Phantom.app'),{recursive:true});
    const exec=f.io.exec;f.io.exec=(bin:string,args:string[])=>bin==='/usr/bin/codesign'&&args.at(-1)==='/Applications/Phantom.app'?{status:1,stdout:''}:exec(bin,args);
    expect(await inspectConsumerDesktopUpgrade(f.deps,{...options,requireApp:true})).toMatchObject({state:'held',reason:'app-needs-owner',app:{state:'needs-owner',reason:'app-identity-unverified'}});
    expect(await inspectConsumerDesktopUpgrade(f.deps,options)).toMatchObject({state:'held',reason:'app-needs-owner',app:{state:'needs-owner'}});
    expect(fs.readlinkSync(f.current)).toBe(f.old);
  });
  it('requires Stop only at apply and never stops the resident on a refusal',async()=> {
    const f=fixture();fs.unlinkSync(join(f.home,'.ashlr/KILL'));const r=await inspectConsumerDesktopUpgrade(f.deps,options);expect(r).toMatchObject({state:'ready',stop:{engaged:false,drained:false}});
    expect(await applyConsumerDesktopUpgrade(r)).toMatchObject({state:'held',reason:'stop-not-engaged',remedyCommand:'phm authority stop'});expect(f.deps.residentStop).not.toHaveBeenCalled();
  });
  it('holds a failed resident stop before switching',async()=> {
    const f=fixture();vi.mocked(f.deps.residentStop).mockResolvedValue({ok:false});
    expect(await applyConsumerDesktopUpgrade(await inspectConsumerDesktopUpgrade(f.deps,options))).toMatchObject({state:'held',reason:'resident-stop-failed'});expect(fs.realpathSync(f.current)).toBe(f.old);
  });
  it('requires a rollback journal and a signed app when explicitly requested',async()=> {
    const f=fixture();expect(await inspectConsumerDesktopUpgrade(f.deps,{...options,mode:'rollback'})).toMatchObject({state:'held',reason:'no-rollback'});
    expect(await inspectConsumerDesktopUpgrade(f.deps,{...options,requireApp:true})).toMatchObject({state:'held',reason:'app-needs-owner',app:{state:'absent'}});
  });
  it.each(['platform','artifact','launcher','release'] as const)('refuses unsafe %s evidence',async kind=> {
    const f=fixture();
    if(kind==='platform')f.deps.platform='linux';
    if(kind==='artifact')f.published.set(f.manifest.cli.url,Buffer.from('wrong'));
    if(kind==='launcher')write(join(f.deps.packageRoot,'bin/ashlr'),'different launcher',0o755);
    if(kind==='release')fs.mkdirSync(join(dirname(f.old),f.manifest.source.revision),{mode:0o700});
    expect(await inspectConsumerDesktopUpgrade(f.deps,options)).toMatchObject({state:'held',reason:{platform:'unsupported-platform',artifact:'artifact-mismatch',launcher:'launcher-identity',release:'release-exists'}[kind]});expect(f.deps.residentStop).not.toHaveBeenCalled();
  });
  it('compares installed authority surfaces without granting or restarting',async()=> {
    const f=fixture(),unknown=await inspectConsumerDesktopUpgrade(f.deps,options);expect(unknown.daemon.restart.touchId).toBe('unknown');
    const staging=join(f.home,'.ashlr/updates/consumer-staging'),pkg=join(staging,fs.readdirSync(staging)[0]!,'package');
    fs.cpSync(join(pkg,'dist'),join(f.old,'dist'),{recursive:true});
    const same=await inspectConsumerDesktopUpgrade(f.deps,options);expect(same.daemon.restart.touchId).toBe(false);expect(same.steps).not.toContain('phm authority grant (Touch ID)');
    const file=join(f.old,'dist/core/authority/fixture.js'),data=Buffer.from('changed surface');write(file,data,0o644);
    const surfaceFile=join(f.old,'dist/authority-surface.json'),surface=JSON.parse(fs.readFileSync(surfaceFile,'utf8'));
    surface.files[0].sha256=sha(data);surface.files[0].bytes=data.length;surface.digest=authoritySurfaceDigest(surface);write(surfaceFile,JSON.stringify(surface),0o644);
    const changed=await inspectConsumerDesktopUpgrade(f.deps,options);
    expect(changed.daemon.restart).toMatchObject({touchId:true,performed:false,reason:expect.stringContaining('authority-surface-changed')});
    expect(changed.steps.slice(-2)).toEqual(['phm authority grant (Touch ID)','phm authority resident start (owner confirmation)']);
  });
  it('accepts ordered flags, explicit versions and routes thin CLI without resident restart',async()=> {
    expect(parseDesktopInstallArgs(['install','--apply','--to','3.30.35','--require-app','--upgrade'])).toEqual({mode:'upgrade',apply:true,to:'3.30.35',requireApp:true});
    expect(parseDesktopInstallArgs(['install','--apply','--rollback'])).toEqual({mode:'rollback',apply:true,requireApp:false});
    for(const args of [['--rollback','--upgrade'],['--rollback','--to','3.30.35'],['--rollback','--require-app'],['--upgrade','--upgrade'],['--upgrade','--to'],['--upgrade','--to','v3.30.35'],['--require-app'],['--to','3.30.35']])expect(()=>parseDesktopInstallArgs(['install',...args])).toThrow();
    const f=fixture(),emit=vi.fn();expect(await cmdDesktop(['install','--upgrade','--to','3.30.35'],undefined,emit,undefined,f.deps)).toBe(0);expect(emit).toHaveBeenCalledWith(expect.objectContaining({state:'ready'}));
  });
});
