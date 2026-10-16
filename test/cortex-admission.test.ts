/** Real policy and real disposable Git: no any-repository seam and no model inference. */
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdCortex } from '../src/cli/cortex.js';
import { admitCortexConfiguration, cortexAdmissionPath, inspectCortexAdmission, revokeCortexConfiguration, withCortexForegroundAdmission, type CortexAdmissionToken } from '../src/core/cortex/admission.js';
import { engineeringAssignmentDigest, engineeringAssignmentSignature } from '../src/core/cortex/engineering-assignment.js';
import { assertMayExecuteWithCortexAdmission, assertMayMutate, enroll, enrollmentPath, isEnrolled, listEnrolled, readEnrollmentRegistry, runWithEnrollmentLens, setKill, unenroll } from '../src/core/sandbox/policy.js';
import { createSandbox, removeSandbox } from '../src/core/sandbox/worktree.js';
import { createProposal } from '../src/core/inbox/store.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import { verifyAndPersistProposal } from '../src/core/inbox/merge.js';
import { runApiModelSandboxed, runEngineSandboxed } from '../src/core/run/sandboxed-engine.js';
import { autonomousConfinementProfile, autonomousVerificationProfile, buildSandboxLauncher } from '../src/core/sandbox/confine.js';
import { applyAutonomousEnvOverlay, buildAutonomousEnvOverlay } from '../src/core/sandbox/autonomous-env.js';
import type { AshlrConfig } from '../src/core/types.js';

const roots: string[] = [];
const repos: string[] = [];
afterEach(() => { setKill(false); for (const repo of repos.splice(0)) if (isEnrolled(repo)) unenroll(repo); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(homedir(), 'cortex-admission-'))); roots.push(root); chmodSync(root, 0o700);
  const repo = join(root, 'repo'); mkdirSync(repo); repos.push(repo);
  const owner = join(root, 'owner'); mkdirSync(owner, { mode: 0o700 }); const records = join(owner, 'records'); mkdirSync(records, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Admission Test'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'cortex-admission-fixture', scripts: { test: 'node -e "process.exit(0)"' } }));
  git('add', 'package.json'); git('commit', '-m', 'fixture'); git('remote', 'add', 'origin', 'https://github.com/ashlrai/cortex-fixture.git');
  const commit = git('rev-parse', 'HEAD'); const pair = generateKeyPairSync('ed25519');
  const config = { schemaVersion: 1, url: 'https://cortex.example.invalid', organizationId: 'company-fixture', tokenEnv: 'CORTEX_WORKER_TOKEN', root: records,
    verifier: { issuer: 'cortex-fixture', audience: 'phantom-fixture', publicKeys: { key1: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() } },
    repositories: [{ repository: 'ashlrai/cortex-fixture', path: repo, workstreams: ['company'] }], runtimes: ['codex'], budget: { maxTokens: 1000, maxSteps: 4, allowCloud: true } };
  const configPath = join(owner, 'config.json'); writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const unsigned = { protocol: 'ashlr-engineering-assignment/v1', version: 1, issuer: 'cortex-fixture', audience: 'phantom-fixture', keyId: 'key1', assignmentId: 'run-fixture', runId: 'run-fixture',
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), organizationRef: 'company-fixture', workstream: 'company',
    repo: { owner: 'ashlrai', name: 'cortex-fixture', defaultBranch: 'main', sourceCommit: commit },
    mission: { objective: 'Produce one isolated patch', successSignals: ['Tests pass'], guardrails: ['No external effects'], allowedFiles: ['feature.txt'] },
    resultContract: { kind: 'verified-proposal', requireDiff: true, requireProposal: true, requireVerification: true, maxChangedFiles: 1, maxChangedLines: 10 },
    authority: { effect: 'proposal-only', requiredTenantRef: 'company-fixture' } } as const;
  const sign = (overrides: Record<string, unknown> = {}) => { const value = { ...unsigned, ...overrides }; const digest = engineeringAssignmentDigest(value); return { ...value, assignmentDigest: digest, assignmentSignature: engineeringAssignmentSignature(digest, pair.privateKey) }; };
  return { root, repo, owner, records, config, configPath, git, commit, sign, assignment: sign() };
}
function registryBytes() { return existsSync(enrollmentPath()) ? readFileSync(enrollmentPath(), 'utf8') : null; }
function gate(repo: string, token: CortexAdmissionToken, purpose: 'produce' | 'verify' = 'produce') { assertMayExecuteWithCortexAdmission(repo, { cortexAdmission: token }, purpose); }

describe('owner-approved Cortex foreground admission', () => {
  it('requires CLI opt-in, and check/once/revoke never silently mint or refresh admission', async () => {
    const f=fixture();const log=vi.spyOn(console,'log').mockImplementation(()=>{}),error=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      expect(await cmdCortex(['admit','--config',f.configPath])).toBe(2);expect(existsSync(cortexAdmissionPath(f.configPath))).toBe(false);
      expect(await cmdCortex(['check','--config',f.configPath,'--json'])).toBe(0);expect(existsSync(cortexAdmissionPath(f.configPath))).toBe(false);
      expect(await cmdCortex(['once','--config',f.configPath])).toBe(2);expect(existsSync(cortexAdmissionPath(f.configPath))).toBe(false);
      expect(await cmdCortex(['admit','--config',f.configPath,'--execute'])).toBe(0);const before=readFileSync(cortexAdmissionPath(f.configPath));
      expect(await cmdCortex(['revoke','--config',f.configPath])).toBe(2);expect(readFileSync(cortexAdmissionPath(f.configPath))).toEqual(before);
      expect(await cmdCortex(['revoke','--config',f.configPath,'--execute'])).toBe(0);expect(existsSync(cortexAdmissionPath(f.configPath))).toBe(false);
    } finally {log.mockRestore();error.mockRestore();}
  });
  it('requires an explicit operator admit and never creates shared enrollment', async () => {
    const f = fixture(), before = registryBytes(); expect(() => inspectCortexAdmission(f.configPath)).toThrow();
    expect(admitCortexConfiguration(f.configPath)).toMatchObject({ state: 'admitted', executionStarted: false, sharedEnrollmentChanged: false });
    expect(() => admitCortexConfiguration(f.configPath)).toThrow('revoked first');
    await withCortexForegroundAdmission(f.configPath, f.assignment, async ({ producer, verifier }) => {
      gate(f.repo, producer); gate(f.repo, verifier, 'verify');
      expect(isEnrolled(f.repo)).toBe(false); expect(listEnrolled()).not.toContain(f.repo); expect(readEnrollmentRegistry()).not.toMatchObject({ repos: [f.repo] });
      expect(() => assertMayMutate(f.repo)).toThrow('not enrolled');
      const sandbox = createSandbox(f.repo, { cortexAdmission: producer });
      expect(sandbox.sourceRepo).toBe(f.repo); expect(removeSandbox(sandbox).status).toBe('complete');
    });
    expect(isEnrolled(f.repo)).toBe(false); expect(registryBytes()).toBe(before);
  });
  it('refuses forged, serialized, wrong-purpose and unrelated globally enrolled capabilities', async () => {
    const f = fixture(), other = fixture(); admitCortexConfiguration(f.configPath); enroll(other.repo);
    await withCortexForegroundAdmission(f.configPath, f.assignment, async ({ producer, verifier }) => {
      expect(JSON.stringify(producer)).toBe('{}');
      expect(() => gate(f.repo, {})).toThrow('forged'); expect(() => gate(f.repo, JSON.parse(JSON.stringify(producer)))).toThrow();
      expect(() => gate(f.repo, verifier)).toThrow('purpose'); expect(() => gate(other.repo, producer)).toThrow('repository');
      expect(() => assertMayMutate(other.repo)).not.toThrow(); // Existing unrelated authority is neither added nor removed.
      for (const malformed of [null, false, 0, '', {}]) {
        expect(() => createSandbox(other.repo, { cortexAdmission: malformed as CortexAdmissionToken })).toThrow('forged');
      }
      expect(() => createSandbox(f.repo, { cortexAdmission: verifier })).toThrow();
      await expect(runEngineSandboxed('claude', 'No contact', {} as AshlrConfig, { sourceRepo: f.repo, cortexAdmission: producer })).rejects.toThrow('only Codex');
      await expect(runApiModelSandboxed('codex', 'No contact', {} as AshlrConfig, { sourceRepo: f.repo, cortexAdmission: producer })).rejects.toThrow('API-model');
    });
  });
  it('preserves restrictive parent enrollment lenses and global KILL', async () => {
    const f = fixture(); admitCortexConfiguration(f.configPath);
    await runWithEnrollmentLens({ label: 'deny all', admits: () => false }, () => withCortexForegroundAdmission(f.configPath, f.assignment, async ({ producer }) => {
      expect(() => gate(f.repo, producer)).toThrow('lens');
    }));
    await withCortexForegroundAdmission(f.configPath, f.assignment, async ({ producer }) => {
      setKill(true); expect(() => gate(f.repo, producer)).toThrow('kill switch'); setKill(false);
    });
  });
  it('revokes detached async descendants after the foreground owner settles', async () => {
    const f = fixture(); admitCortexConfiguration(f.configPath); enroll(f.repo); let release!: () => void; const wait = new Promise<void>(r => { release = r; }); let detached!: Promise<boolean>;
    await withCortexForegroundAdmission(f.configPath, f.assignment, async ({ producer }) => {
      detached = wait.then(() => {
        expect(() => gate(f.repo, producer)).toThrow('closed');
        expect(() => createSandbox(f.repo, { cortexAdmission: producer })).toThrow('closed');
        return true;
      });
    });
    release(); expect(await detached).toBe(true);
  });
  it('isolates concurrent contexts and rejects nested activation', async () => {
    const a = fixture(), b = fixture(); admitCortexConfiguration(a.configPath); admitCortexConfiguration(b.configPath);
    let aToken!: CortexAdmissionToken, bToken!: CortexAdmissionToken; let release!: () => void; const ready = new Promise<void>(r => { release = r; }); let count = 0;
    await Promise.all([a,b].map(async (f,index) => withCortexForegroundAdmission(f.configPath,f.assignment,async ({producer})=>{
      if(index===0)aToken=producer;else bToken=producer; if(++count===2)release();await ready;
      gate(f.repo,producer);expect(()=>gate(f.repo,index===0?bToken:aToken)).toThrow();
      await expect(withCortexForegroundAdmission(f.configPath,f.assignment,async()=>{})).rejects.toThrow('nested');
    })));
  });
  it('requires independently valid Company signature, tenant, expiry and exact source', async () => {
    const f = fixture(); admitCortexConfiguration(f.configPath);
    for (const bad of [{...f.assignment,mission:{...f.assignment.mission,objective:'Forged'}},f.sign({workstream:'govcon'}),f.sign({organizationRef:'other'}),f.sign({expiresAt:new Date(Date.now()-500).toISOString()}),f.sign({repo:{...f.assignment.repo,sourceCommit:'f'.repeat(40)}})]) {
      await expect(withCortexForegroundAdmission(f.configPath,bad,async()=>{throw new Error('must not execute');})).rejects.toThrow('Cortex admission');
    }
  });
  it('rejects symlink/hardlink/public configuration and in-repository admission storage', () => {
    const f=fixture(); const alias=join(f.owner,'alias.json');symlinkSync(f.configPath,alias);expect(()=>admitCortexConfiguration(alias)).toThrow('physical');
    const hard=join(f.owner,'hard.json');linkSync(f.configPath,hard);expect(()=>admitCortexConfiguration(f.configPath)).toThrow('private');rmSync(hard);
    chmodSync(f.configPath,0o644);expect(()=>admitCortexConfiguration(f.configPath)).toThrow('private');chmodSync(f.configPath,0o600);
    const inside=join(f.repo,'config.json');writeFileSync(inside,JSON.stringify(f.config),{mode:0o600});chmodSync(f.repo,0o700);expect(()=>admitCortexConfiguration(inside)).toThrow('outside');
  });
  it('rejects aliases and dirty, retargeted or replaced source repositories', () => {
    const f=fixture();const alias=join(f.root,'alias');symlinkSync(f.repo,alias);f.config.repositories[0]!.path=alias;writeFileSync(f.configPath,JSON.stringify(f.config));expect(()=>admitCortexConfiguration(f.configPath)).toThrow('physical');
    f.config.repositories[0]!.path=f.repo;writeFileSync(f.configPath,JSON.stringify(f.config));writeFileSync(join(f.repo,'dirty'),'x');expect(()=>admitCortexConfiguration(f.configPath)).toThrow('clean');rmSync(join(f.repo,'dirty'));
    admitCortexConfiguration(f.configPath);f.git('remote','set-url','origin','https://github.com/other/repository.git');expect(()=>inspectCortexAdmission(f.configPath)).toThrow('origin');
  });
  it('fails closed after config replacement even when the repo is globally enrolled', async () => {
    const f=fixture();admitCortexConfiguration(f.configPath);enroll(f.repo);
    await withCortexForegroundAdmission(f.configPath,f.assignment,async({producer})=>{
      const bytes=readFileSync(f.configPath);renameSync(f.configPath,`${f.configPath}.old`);writeFileSync(f.configPath,bytes,{mode:0o600});
      expect(()=>gate(f.repo,producer)).toThrow('binding changed');expect(()=>assertMayMutate(f.repo)).not.toThrow();
    });
    expect(revokeCortexConfiguration(f.configPath).state).toBe('revoked'); // Stale config is revocable, not silently re-admitted.
  });
  it('pins records-root and config-parent directory identity', () => {
    const f=fixture();admitCortexConfiguration(f.configPath);renameSync(f.records,`${f.records}.old`);mkdirSync(f.records,{mode:0o700});expect(()=>inspectCortexAdmission(f.configPath)).toThrow('storage');
    const g=fixture();admitCortexConfiguration(g.configPath);renameSync(g.owner,`${g.owner}.old`);mkdirSync(g.owner,{mode:0o700});
    for(const name of ['config.json','.config.json.cortex-admission.json','records'])renameSync(join(`${g.owner}.old`,name),join(g.owner,name));
    expect(()=>inspectCortexAdmission(g.configPath)).toThrow(/storage|binding/);
  });
  it('pins physical repository and Git common-directory identities, not only source bytes', () => {
    const f=fixture();admitCortexConfiguration(f.configPath);renameSync(f.repo,`${f.repo}.old`);cpSync(`${f.repo}.old`,f.repo,{recursive:true});expect(()=>inspectCortexAdmission(f.configPath)).toThrow('source policy');
    const g=fixture();admitCortexConfiguration(g.configPath);renameSync(join(g.repo,'.git'),join(g.repo,'.git-old'));cpSync(join(g.repo,'.git-old'),join(g.repo,'.git'),{recursive:true});rmSync(join(g.repo,'.git-old'),{recursive:true});expect(()=>inspectCortexAdmission(g.configPath)).toThrow('source policy');
  });
  it('rejects replaced sidecars in an active scope and changed implementation bindings', async () => {
    const f=fixture();admitCortexConfiguration(f.configPath);const path=cortexAdmissionPath(f.configPath);
    await withCortexForegroundAdmission(f.configPath,f.assignment,async({producer})=>{
      const bytes=readFileSync(path);renameSync(path,`${path}.old`);writeFileSync(path,bytes,{mode:0o600});expect(()=>gate(f.repo,producer)).toThrow('replaced');
    });
    const record=JSON.parse(readFileSync(path,'utf8'));record.implementationSha256='0'.repeat(64);writeFileSync(path,JSON.stringify(record));expect(()=>inspectCortexAdmission(f.configPath)).toThrow('implementation');
  });
  it('revokes active capabilities, signals abort and never falls back to global enrollment', async () => {
    const f=fixture();admitCortexConfiguration(f.configPath);enroll(f.repo);
    await withCortexForegroundAdmission(f.configPath,f.assignment,async({producer,signal})=>{
      revokeCortexConfiguration(f.configPath);expect(()=>gate(f.repo,producer)).toThrow();
      await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});
      expect(signal.aborted).toBe(true);expect(()=>gate(f.repo,producer)).toThrow();expect(isEnrolled(f.repo)).toBe(true);
    });
  });
  it('does not remove malformed or foreign files through revoke', () => {
    const f=fixture();const path=cortexAdmissionPath(f.configPath);writeFileSync(path,'{"private":"unrelated"}',{mode:0o600});expect(()=>revokeCortexConfiguration(f.configPath)).toThrow('unrecognized');expect(readFileSync(path,'utf8')).toContain('unrelated');
  });
  it.skipIf(process.platform!=='darwin')('keeps private admission and configuration outside native producer and verifier write authority', async () => {
    const f=fixture();admitCortexConfiguration(f.configPath);const configBefore=readFileSync(f.configPath),recordBefore=readFileSync(cortexAdmissionPath(f.configPath));
    await withCortexForegroundAdmission(f.configPath,f.assignment,async({producer})=>{
      const sandbox=createSandbox(f.repo,{cortexAdmission:producer});
      try {
        for(const [index,profile] of [autonomousConfinementProfile('codex'),{...autonomousVerificationProfile(),loopbackServers:false}].entries()) {
          const runTmpDir=join(f.root,`native-${index}`);mkdirSync(runTmpDir,{mode:0o700});
          // No CLI/provider authentication is needed to probe the same OS profiles.
          const overlay=buildAutonomousEnvOverlay({engine:'local-coder',seatId:null,runTmpDir,home:homedir(),path:'/usr/bin:/bin'});
          const launcher=buildSandboxLauncher({...profile,denyCodexProjectConfig:true},{worktree:sandbox.worktreePath,home:homedir(),overlay});expect(launcher).not.toBeNull();
          const probe='touch inside.txt || exit 8; for target in "$@"; do if (printf planted > "$target") 2>/dev/null; then exit 9; fi; done';
          const result=spawnSync(launcher!.bin,[...launcher!.prefixArgs,'/bin/sh','-c',probe,'probe',f.configPath,cortexAdmissionPath(f.configPath),join(f.records,'planted.json')],
            {cwd:sandbox.worktreePath,env:applyAutonomousEnvOverlay({PATH:'/usr/bin:/bin',LANG:'C'},overlay),encoding:'utf8',timeout:10000});
          expect(result.status,result.stderr).toBe(0);
        }
        expect(readFileSync(f.configPath)).toEqual(configBefore);expect(readFileSync(cortexAdmissionPath(f.configPath))).toEqual(recordBefore);expect(existsSync(join(f.records,'planted.json'))).toBe(false);
      } finally {removeSandbox(sandbox);}
    });
  });
  it.skipIf(process.platform!=='darwin')('persists independent confined verification under only the run verification capability', async () => {
    const f=fixture();admitCortexConfiguration(f.configPath);
    const diff='diff --git a/feature.txt b/feature.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/feature.txt\n@@ -0,0 +1 @@\n+hello\n';const diffHash=hashDiff(diff);
    const proposal=createProposal({repo:f.repo,origin:'agent',kind:'patch',title:'Fixture proposal',summary:'Verify without global enrollment',diff,diffHash,provenanceSig:signProvenance('codex:fixture','frontier',diffHash),engineModel:'codex:fixture',engineTier:'frontier'});
    const cfg={foundry:{autoMerge:{enabled:false,allowWithoutVerification:false}}} as AshlrConfig;
    await withCortexForegroundAdmission(f.configPath,f.assignment,async({producer,verifier})=>{
      expect((await verifyAndPersistProposal(proposal,cfg,'cortex-bridge',{cortexAdmission:producer})).authorityLive).toBe(false);
      const result=await verifyAndPersistProposal(proposal,cfg,'cortex-bridge',{cortexAdmission:verifier});
      expect(result.verify.ok,result.reason+': '+result.verify.detail).toBe(true);expect(result.persisted).toBe(true);expect(result.authorityLive).toBe(true);expect(result.verify.baseHead).toBe(f.commit);
      expect(isEnrolled(f.repo)).toBe(false);expect(()=>assertMayMutate(f.repo)).toThrow('not enrolled');
    });
  });
});
