import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {posix} from 'node:path';
import {canonicalJson} from '../authority/canonical-json.js';
import {verifyAuthoritySurfaceAt} from '../authority/surface.js';
import {readPinnedRuntimeArchive, extractPinnedRuntimeArchive, type PinnedRuntimeArchiveOptions} from '../local-runtime/archive.js';
import {fsyncDirectory} from '../util/durability.js';
import {ConsumerInstallHeld, checkConsumerQuiescence, quiescenceHold, createConsumerInstallDependencies, directory, parents, owned, regular, write, sha, ioRead, packageReady,
  type ConsumerInstallDependencies, type ConsumerInstallIo, type ConsumerTransaction} from './consumer-install.js';
import {extractSignedAppArchive} from './qualified-update.js';
import {verifyCompatibleUpdateManifest, verifyMinisign, verifyUpdateBundleRecord, type CompatibleUpdateManifest} from './update-manifest.js';

const {basename, join}=posix;

export interface ConsumerUpgradeDependencies extends ConsumerInstallDependencies {
  smokeVersion(launcher: string): Promise<string|null>;
  residentStop(): Promise<{ok:boolean; reason?:string}>;
}
export interface ConsumerUpgradeOptions {mode:'upgrade'|'rollback'; apply:boolean; requireApp:boolean; to?:string}
type Release = {version:string; release:string};
export interface ConsumerUpgradeResult {
  schema:'desktop-upgrade.v1'; mode:'upgrade'|'rollback';
  state:'ready'|'current'|'upgraded'|'reverted'|'rolled-back'|'held'; reason:string|null;
  applied:boolean; authorityResumed:false; installed:Release|null; candidate:Release|null; previous:Release|null;
  path?: string; remedyCommand?: string; tightenedPaths?: readonly string[];
  app:{state:'current'|'update-available'|'needs-owner'|'absent'|'unknown'; reason:string|null};
  stop:{engaged:boolean|null; drained:boolean|null; reason:string|null; command:'phm authority stop'};
  daemon:{stop:{command:'phm authority resident stop'; performed:boolean; confirmation:'none'};
    restart:{command:'phm authority resident start'; performed:false; ownerConfirmation:true; touchId:boolean|'unknown'; reason:string|null}};
  steps:string[];
}
const semver=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releasePattern=/^[a-f0-9]{40}$/;
class Held extends Error {}
function need(value:unknown,reason:string):asserts value {if(!value)throw new Held(reason);}
function heldReason(error:unknown,r:ConsumerUpgradeResult):string|null {
  if(error instanceof ConsumerInstallHeld) {
    if(error.path)r.path=error.path;
    if(error.remedyCommand)r.remedyCommand=error.remedyCommand;
    return error.reason;
  }
  if(error instanceof Held)return error.message;
  return null;
}
function versionAt(root:string):string {
  const pkg=JSON.parse(regular(join(root,'package.json'),65536).data.toString());
  need(pkg.name==='@ashlr/phantom' && typeof pkg.version==='string' && semver.test(pkg.version),'unmanaged-current');return pkg.version;
}
function compare(a:string,b:string):number {
  const x=a.split('.').map(BigInt),y=b.split('.').map(BigInt);
  for(let i=0;i<3;i++) {if(x[i]!==y[i])return x[i]!>y[i]!?1:-1;}return 0;
}
type Pointer=NonNullable<ReturnType<ConsumerInstallIo['readCurrentPointer']>>;
interface Admission {
  deps:ConsumerUpgradeDependencies; helper:ConsumerTransaction; io:ConsumerInstallIo; before:Pointer;
  aliases:ReturnType<ConsumerTransaction['inspectLocalAliases']>; destination:string; manifest?:CompatibleUpdateManifest;
  pins?:PinnedRuntimeArchiveOptions; journal?:Journal; attempted:boolean;
  selected?:NonNullable<ReturnType<ConsumerTransaction['selectLocalApp']>>;
  source?:ReturnType<ConsumerTransaction['inspectLocalApp']>;
  retryCommand:string;
}
const appPaths=['/Applications/Phantom.app','/Applications/Ashlr.app'];
function appPresent(io:ConsumerInstallIo):boolean {
  return appPaths.some(path=>io.exists(path));
}
function requireOlderApp(selected:NonNullable<Admission['selected']>, version:string, io:ConsumerInstallIo):void {
  const read=io.exec('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',join(selected.path,'Contents/Info.plist')]);
  const installed=read.stdout.trim();
  need(read.status===0&&semver.test(installed),'app-version-unverified');
  need(compare(installed,version)<0,'app-not-older');
}
type Journal={schema:'desktop-upgrade-journal.v1'; previous:Release; current:Release};
const admissions=new WeakMap<ConsumerUpgradeResult,Admission>();
function freeze(r:ConsumerUpgradeResult):ConsumerUpgradeResult {
  for(const value of Object.values(r))if(value && typeof value==='object')Object.freeze(value);
  Object.freeze(r.daemon.stop);Object.freeze(r.daemon.restart);return Object.freeze(r);
}
function initial(mode:ConsumerUpgradeOptions['mode']):ConsumerUpgradeResult {
  return {schema:'desktop-upgrade.v1',mode,state:'held',reason:null,applied:false,authorityResumed:false,installed:null,candidate:null,previous:null,
    app:{state:'unknown',reason:null},stop:{engaged:null,drained:null,reason:null,command:'phm authority stop'},
    daemon:{stop:{command:'phm authority resident stop',performed:false,confirmation:'none'},restart:{command:'phm authority resident start',performed:false,ownerConfirmation:true,touchId:'unknown',reason:null}},steps:[]};
}
async function quiescence(a:Admission,r:ConsumerUpgradeResult,recover=false):Promise<void> {
  try {const s=fs.lstatSync(join(a.deps.home,'.ashlr/KILL'));r.stop.engaged=s.isFile()&&!s.isSymbolicLink();}catch {r.stop.engaged=false;}
  try {await checkConsumerQuiescence(a.helper,a.io,recover);r.stop.drained=true;r.stop.reason=null;delete r.remedyCommand;}
  catch(error) {
    const hold=quiescenceHold(error,a.retryCommand)??new ConsumerInstallHeld('quiescence-unavailable',undefined,a.retryCommand);
    r.stop.drained=false;r.stop.reason=hold.reason;r.remedyCommand=hold.remedyCommand;
    throw hold;
  }
}
function touchId(r:ConsumerUpgradeResult,root:string,digest:string):void {
  try {const old=verifyAuthoritySurfaceAt(root,'installed',{fresh:true});if(old.ok)r.daemon.restart.touchId=old.digest!==digest;}catch { /* Unknown remains unknown. */ }
  r.daemon.restart.reason=r.daemon.restart.touchId===true?'authority-surface-changed: standing grant is surface-bound; run phm authority grant (Touch ID) before resident start':null;
}
/** Inspection writes only private staged public artifacts. Admission cannot be serialized or replayed. */
export async function inspectConsumerDesktopUpgrade(input:ConsumerUpgradeDependencies,options:ConsumerUpgradeOptions):Promise<ConsumerUpgradeResult> {
  const deps=Object.freeze({...input,trust:Object.freeze({...input.trust,repository:Object.freeze({...input.trust.repository})})}),r=initial(options.mode);
  const tightenedPaths=options.apply?[] as string[]:undefined;
  if(tightenedPaths)r.tightenedPaths=tightenedPaths;
  try {
    need(deps.platform==='darwin'&&deps.architecture==='arm64','unsupported-platform');deps.assertRunning();
    const helper=await deps.transaction(),io=helper.createLocalAppTransactionIo({home:deps.home,packageRoot:deps.packageRoot});io.log=()=>{};
    const releases=join(deps.home,'.local/share/ashlr/releases');
    parents(deps.home,releases,false,tightenedPaths,true);
    const current=join(deps.home,'.local/share/ashlr/current');let before:Pointer|null;
    try {before=io.readCurrentPointer(current);}catch {throw new Held('unmanaged-current');}
    need(before,'not-installed');need(releasePattern.test(basename(before.target)),'unmanaged-current');
    let aliases:Admission['aliases'];try {aliases=helper.inspectLocalAliases(io);need(aliases.length===2&&aliases.every(x=>x.identity!==null),'unmanaged-links');}catch {throw new Held('unmanaged-links');}
    parents(deps.home,before.target,false,tightenedPaths);
    r.installed={version:versionAt(before.target),release:basename(before.target)};
    const a:Admission={deps,helper,io,before,aliases,destination:'',attempted:false,
      retryCommand:`phm desktop install --${options.mode}${options.to&&semver.test(options.to)?' --to '+options.to:''}${options.requireApp?' --require-app':''} --apply`};
    if(options.mode==='rollback') {
      need(!appPresent(io),'paired-rollback-required');
      let journal:Journal;
      try {journal=JSON.parse(owned(join(deps.home,'.local/share/ashlr/upgrade.json'),8192).data.toString());}catch {throw new Held('no-rollback');}
      need(journal.schema==='desktop-upgrade-journal.v1' && [journal.previous,journal.current].every(x=>x&&releasePattern.test(x.release)&&semver.test(x.version)),'no-rollback');
      need(before.target===join(releases,journal.current.release)&&r.installed.version===journal.current.version,'current-changed');
      a.destination=join(releases,journal.previous.release);parents(deps.home,a.destination,false,tightenedPaths);directory(a.destination);
      need(versionAt(a.destination)===journal.previous.version,'no-rollback');
      need(io.isCanonicalLauncher(join(a.destination,'bin/ashlr')),'launcher-identity');
      need(await deps.smokeVersion(join(a.destination,'bin/ashlr'))===journal.previous.version,'smoke-failed');
      a.journal=journal;r.candidate={version:journal.previous.version,release:journal.previous.release};r.previous={version:journal.current.version,release:journal.current.release};
      const surface=verifyAuthoritySurfaceAt(a.destination,'installed',{fresh:true});if(surface.ok)touchId(r,before.target,surface.digest!);
    } else {
      need(options.to===undefined||semver.test(options.to),'invalid-version');
      const url=options.to?`https://github.com/ashlrai/phantom/releases/download/v${options.to}/latest.json`:'https://github.com/ashlrai/phantom/releases/latest/download/latest.json';
      const raw=await deps.download(url,128*1024);need(raw.length<=128*1024,'discovery-size');const latest=JSON.parse(raw.toString());
      const m=verifyCompatibleUpdateManifest(latest.phantom,deps.trust).manifest;
      need(m.schemaVersion===2 && (!options.to||m.version===options.to),'release-mismatch');
      need(canonicalJson(latest)===canonicalJson({version:m.version,platforms:{'darwin-aarch64':{url:m.app.url,signature:m.app.signature}},phantom:latest.phantom}),'discovery-mismatch');
      r.candidate={version:m.version,release:m.source.revision};r.previous=r.installed;
      const order=compare(m.version,r.installed.version);need(order>=0,'downgrade-refused');
      try {
        const selected=helper.selectLocalApp(m.app.signer,io);
        if(selected) {
          a.selected=selected;
          r.app=selected.inventory===m.app.inventorySha256?{state:'current',reason:null}:{state:'update-available',reason:'native-signed-update'};
        } else r.app={state:'absent',reason:null};
      } catch {r.app={state:'needs-owner',reason:'app-identity-unverified'};}
      need(r.app.state!=='needs-owner'&&(!options.requireApp||r.app.state!=='absent'),'app-needs-owner');
      if(r.app.state==='update-available')requireOlderApp(a.selected!,m.version,io);
      if(order===0&&r.app.state==='absent'){r.state='current';r.reason='already-current';return freeze(r);}
      a.destination=join(releases,m.source.revision);
      if(order===0) need(a.destination===before.target,'installed-current-unverified');
      else try {fs.lstatSync(a.destination);throw new Held('release-exists');}catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const downloaded=await Promise.all([deps.download(m.app.url,m.app.bytes),deps.download(m.cli.url,m.cli.bytes)]);
      for(const [i,artifact] of [m.app,m.cli].entries()) {
        try {need(downloaded[i]!.length===artifact.bytes&&sha(downloaded[i]!)===artifact.sha256,'artifact-mismatch');verifyMinisign(downloaded[i]!,artifact.signature,deps.trust.publicKey);}catch {throw new Held('artifact-mismatch');}
      }
      const staging=join(deps.home,'.ashlr/updates/consumer-staging');parents(deps.home,staging,true,tightenedPaths);const stage=fs.mkdtempSync(join(staging,'upgrade-'));fs.chmodSync(stage,0o700);
      write(join(stage,'app.tar.gz'),downloaded[0]!);write(join(stage,'package.tgz'),downloaded[1]!);
      try {
        const appStage=join(stage,'app');fs.mkdirSync(appStage,{mode:0o700});const appRoot=extractSignedAppArchive(downloaded[0]!,appStage);
        const source=helper.inspectLocalApp(appRoot,m.app.signer,io);
        need(source.inventory===m.app.inventorySha256,'app-artifact');verifyUpdateBundleRecord(ioRead(appRoot),m);a.source=source;
      }catch {throw new Held('app-artifact');}
      const pins:PinnedRuntimeArchiveOptions={artifactPath:join(stage,'package.tgz'),sha256:m.cli.sha256,revision:m.source.revision,version:m.version,identityProfile:'canonical-v2'};
      const archive=await readPinnedRuntimeArchive(pins),pkg=order===0?before.target:join(stage,'package');
      if(order>0){fs.mkdirSync(pkg,{mode:0o700});extractPinnedRuntimeArchive(archive,pkg);}
      await packageReady(pkg,{pins,manifest:m});
      need(regular(join(pkg,'bin/ashlr'),65536).data.equals(regular(join(deps.packageRoot,'bin/ashlr'),65536).data),'launcher-identity');a.pins=pins;a.manifest=m;
      if(r.app.state==='current')verifyUpdateBundleRecord(io.readBoundedFile(join(a.selected!.path,'Contents/Resources/phantom-release.json'),8192),m);
      if(order===0&&r.app.state==='current'){r.state='current';r.reason='already-current';return freeze(r);}
      touchId(r,before.target,m.authoritySurfaceDigest);
    }
    try {await quiescence(a,r,options.apply);}catch(error) {if(options.apply)throw error;}
    r.steps=['phm authority stop','Close Phantom normally and drain work','phm authority resident stop','Switch managed CLI release; keep previous release'];
    if(r.app.state==='update-available')r.steps.push('Install the paired signed Phantom.app');
    if(r.daemon.restart.touchId===true)r.steps.push('phm authority grant (Touch ID)');
    r.steps.push('phm authority resident start (owner confirmation)');
    r.state='ready';const observed=freeze(r);admissions.set(observed,a);return observed;
  }catch(error){r.reason=heldReason(error,r)??'inspection-unavailable';if(r.reason==='not-installed')r.steps=['phm desktop install'];return freeze(r);}
}
function writeJournal(home:string,journal:Journal):void {
  const root=join(home,'.local/share/ashlr');parents(home,root,false);const temp=join(root,`.upgrade-${randomBytes(12).toString('hex')}`);
  write(temp,Buffer.from(JSON.stringify(journal)));fs.renameSync(temp,join(root,'upgrade.json'));fsyncDirectory(root);
}
/** Consume a fresh inspection once, lowering resident authority before the atomic switch. */
export async function applyConsumerDesktopUpgrade(observed:ConsumerUpgradeResult):Promise<ConsumerUpgradeResult> {
  const a=admissions.get(observed),r:ConsumerUpgradeResult=structuredClone(observed);
  if(!a||a.attempted||observed.state!=='ready')return freeze({...r,state:'held',reason:'inspection-required'});a.attempted=true;
  const {deps,helper,io}=a,current=join(deps.home,'.local/share/ashlr/current');let created:fs.Stats|undefined,switched:Pointer|undefined;
  const repair=a.destination===a.before.target;
  const tightenedPaths=[...(r.tightenedPaths??[])];r.tightenedPaths=tightenedPaths;
  try {
    deps.assertRunning();await quiescence(a,r,true);
    need(canonicalJson(io.readCurrentPointer(current))===canonicalJson(a.before),'current-changed');assert.deepEqual(helper.inspectLocalAliases(io),a.aliases);
    if(a.manifest&&a.pins) {
      const archive=await readPinnedRuntimeArchive(a.pins);parents(deps.home,join(deps.home,'.local/share/ashlr/releases'),false,tightenedPaths);
      if(!repair){fs.mkdirSync(a.destination,{mode:0o700});created=directory(a.destination);extractPinnedRuntimeArchive(archive,a.destination);}
      await packageReady(a.destination,{pins:a.pins,manifest:a.manifest});
    } else {
      parents(deps.home,a.destination,false,tightenedPaths);need(versionAt(a.destination)===r.candidate!.version,'no-rollback');
      need(io.isCanonicalLauncher(join(a.destination,'bin/ashlr')),'launcher-identity');
      need(canonicalJson(JSON.parse(owned(join(deps.home,'.local/share/ashlr/upgrade.json'),8192).data.toString()))===canonicalJson(a.journal),'current-changed');
    }
    try {need(await deps.smokeVersion(join(a.destination,'bin/ashlr'))===r.candidate!.version,'smoke-failed');}catch {throw new Held('smoke-failed');}
    await quiescence(a,r);deps.assertRunning();assert.deepEqual(io.readCurrentPointer(current),a.before);assert.deepEqual(helper.inspectLocalAliases(io),a.aliases);
    try {need((await deps.residentStop()).ok,'resident-stop-failed');}catch {throw new Held('resident-stop-failed');}r.daemon.stop.performed=true;
    await quiescence(a,r);assert.deepEqual(io.readCurrentPointer(current),a.before);
    if(a.manifest&&a.pins&&a.source&&a.selected&&r.app.state==='update-available') {
      const {manifest,pins,source,selected}=a;
      let phase:string|undefined;
      const writeInstallJournal=io.writeInstallJournal.bind(io);
      const installIo={...io,writeInstallJournal:(owner:string,value:{phase:string})=>{writeInstallJournal(owner,value);phase=value.phase;}};
      const before=async(afterAppMove:boolean)=> {
        deps.assertRunning();await packageReady(a.destination,{pins,manifest});
        assert.deepEqual(io.readCurrentPointer(current),a.before);assert.deepEqual(helper.inspectLocalAliases(io),a.aliases);
        assert.deepEqual(helper.inspectLocalApp(source.path,manifest.app.signer,io),source);verifyUpdateBundleRecord(ioRead(source.path),manifest);
        const active=helper.selectLocalApp(manifest.app.signer,io);
        if(afterAppMove) need(active?.inventory===source.inventory,'installed-app-changed');
        else {assert.deepEqual(active,selected);requireOlderApp(selected,manifest.version,io);}
        await quiescence(a,r);
      };
      try {
        await helper.installLocalApp({selected,source:source.path,sourceProof:source,signer:manifest.app.signer,version:manifest.version,native:true,preserveSigned:true,previousCurrent:a.before.target,
          beforeSwitch:()=>before(false),
          commitPointer:async()=>{await before(true);if(!repair)switched=io.switchCurrentPointer(current,a.before,a.destination);},
          rollbackPointer:async()=>{
            if(switched){io.restoreCurrentPointer(current,a.before,switched);switched=undefined;}
            else assert.deepEqual(io.readCurrentPointer(current),a.before);
          },
          health:async()=>{
            const deadline=io.clock()+30_000;
            while(io.clock()<deadline) {
              if(helper.launchedAppIsOwned(io)&&await io.fetchStatus('http://127.0.0.1:7777/verse/')===200) {
                await packageReady(a.destination,{pins,manifest});assert.deepEqual(io.readCurrentPointer(current),switched??a.before);
                need(await deps.smokeVersion(join(current,'bin/ashlr'))===manifest.version,'post-switch-smoke');return true;
              }
              await io.sleep(1000);
            }
            return false;
          }},installIo);
      } catch(error) {
        const hold=quiescenceHold(error,a.retryCommand);
        if(hold) {
          if(hold.reason==='stop-not-engaged')r.stop.engaged=false;
          r.stop.drained=false;r.stop.reason=hold.reason;
          heldReason(hold,r);
        }
        if(phase==='rollback-held'){created=undefined;throw new Held('rollback-held');}
        if(phase==='rolled-back'){r.state='rolled-back';r.reason=heldReason(hold??error,r)??'app-install-failed';}
        throw hold??error;
      }
      r.app={state:'current',reason:null};
      if(!repair) {
        try {writeJournal(deps.home,{schema:'desktop-upgrade-journal.v1',previous:r.installed!,current:r.candidate!});}
        catch {r.state='upgraded';r.applied=true;r.reason='journal-failed';return freeze(r);}
      }
      r.state='upgraded';r.applied=true;r.reason=null;return freeze(r);
    }
    if(a.manifest) {
      if(a.selected) assert.deepEqual(helper.selectLocalApp(a.manifest.app.signer,io),a.selected);
      else need(!appPresent(io),'app-identity-changed');
    } else need(!appPresent(io),'paired-rollback-required');
    switched=io.switchCurrentPointer(current,a.before,a.destination);
    try {assert.deepEqual(helper.inspectLocalAliases(io),a.aliases);need(await deps.smokeVersion(join(current,'bin/ashlr'))===r.candidate!.version,'post-switch-smoke');}
    catch {
      try {io.restoreCurrentPointer(current,a.before,switched);}catch {throw new Held('rollback-held');}
      r.state='rolled-back';r.reason='post-switch-smoke';return freeze(r);
    }
    try {writeJournal(deps.home,{schema:'desktop-upgrade-journal.v1',previous:r.installed!,current:r.candidate!});}
    catch {
      try {io.restoreCurrentPointer(current,a.before,switched);}catch {throw new Held('rollback-held');}
      throw new Held('journal-failed');
    }
    r.state=r.mode==='rollback'?'reverted':'upgraded';r.applied=true;r.reason=null;return freeze(r);
  }catch(error) {
    if(created&&!switched) {
      try {const now=directory(a.destination);if(now.dev===created.dev&&now.ino===created.ino)fs.rmSync(a.destination,{recursive:true,force:true});}catch { /* Preserve uncertain ownership. */ }
    }
    if(r.state==='rolled-back')return freeze(r);
    r.state='held';r.reason=heldReason(error,r)??'upgrade-unavailable';return freeze(r);
  }
}
export function createConsumerUpgradeDependencies():ConsumerUpgradeDependencies {
  const deps=createConsumerInstallDependencies();return {...deps,
    smokeVersion:async launcher=> {
      const child=spawnSync(process.execPath,[launcher,'--version'],{encoding:'utf8',timeout:5000,maxBuffer:1024,env:{HOME:deps.home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C',LC_ALL:'C'}});
      const version=child.stdout?.trim();return !child.error&&child.status===0&&version&&semver.test(version)?version:null;
    },residentStop:async()=> {
      try {const service=await import('../daemon/service.js');await service.uninstall({});}catch {return {ok:false,reason:'resident-stop-failed'};}
      try {const {appendLedger}=await import('../authority/ledger.js');appendLedger({kind:'note',actor:'mason',grantId:null,repo:null,data:{topic:'resident-service:stop',detail:'Resident service stopped for desktop upgrade'}});}catch { /* Lowering does not depend on the ledger. */ }
      return {ok:true};
    }};
}
