import copy,json,os,pathlib,shlex,subprocess,tempfile,unittest
HERE=pathlib.Path(__file__).resolve().parent
A='a'*40; H='b'*40; REPO={'id':1263526319,'full_name':'ashlrai/phantom'}
def run(rid,attempt,sha,workflow):
 return {'id':rid,'run_attempt':attempt,'head_sha':sha,'head_branch':'master','path':'.github/workflows/'+workflow+'.yml','status':'completed','conclusion':'success','repository':REPO,'head_repository':REPO}
def artifact(aid,name,rid,sha):
 return {'id':aid,'name':name,'expired':False,'digest':'sha256:'+'c'*64,'workflow_run':{'id':rid,'head_sha':sha,'repository_id':1263526319,'head_repository_id':1263526319}}
def inventory(rows):return {'total_count':len(rows),'artifacts':rows}
def fixtures():
 att=run(22,2,A,'attest-ci-build'); ci=run(11,2,H,'ci'); aud=run(33,1,H,'dependency-audit')
 return {
 'repos/ashlrai/phantom/commits/master':{'sha':A},
 'repos/ashlrai/phantom/actions/workflows/attest-ci-build.yml/runs?status=success&per_page=20':{'total_count':1,'workflow_runs':[att]},
 'repos/ashlrai/phantom/actions/workflows/attest-ci-build.yml/runs?status=success&per_page=1':{'total_count':1,'workflow_runs':[att]},
 'repos/ashlrai/phantom/actions/runs/22':att,
 'repos/ashlrai/phantom/actions/runs/22/artifacts?per_page=100':inventory([artifact(201,'ashlr-attested-11-2-22-1',22,A),artifact(202,'ashlr-attested-11-2-22-2',22,A)]),
 'repos/ashlrai/phantom/actions/runs/11/attempts/2':ci,
 'repos/ashlrai/phantom/actions/runs/11/artifacts?per_page=100':inventory([artifact(101,'ashlr-build-11-1',11,H),artifact(102,'ashlr-build-11-2',11,H)]),
 'repos/ashlrai/phantom/tags?per_page=100':[{'name':'v9.9.9','commit':{'sha':H}}],
 'repos/ashlrai/phantom/actions/workflows/dependency-audit.yml/runs?head_sha='+H+'&status=success&per_page=1':{'workflow_runs':[aud]},
 'repos/ashlrai/phantom/actions/runs/33':aud,
 }
class AutorunTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='autorun-fixture-');self.root=pathlib.Path(self.tmp.name);self.data=fixtures()
  (self.root/'bin').mkdir();(self.root/'release-sign/autorun').mkdir(parents=True)
  (self.root/'bin/scrub.pl').write_text('while (<STDIN>) { print; }\n')
  (self.root/'release-sign/keychain-allowed').touch()
  self.gh=self.root/'fake-gh';self.rs=self.root/'fake-signer'
  self.gh.write_text('#!/usr/bin/python3 -I\nimport pathlib,json,sys\nr=pathlib.Path('+repr(str(self.root))+')\na=sys.argv[1:]\nassert a[0]=="api" and not any(x in ("-X","--method","-f","-F","--input") for x in a)\nep=a[-1]\nlog=r/"gh.calls"\nold=log.read_text().splitlines() if log.exists() else []\nwith log.open("a")as f:f.write(ep+"\\n")\nd=json.loads((r/"fixtures.json").read_text())\nif ep not in d:sys.exit(2)\nv=d[ep]\nif isinstance(v,dict) and "sequence"in v:v=v["sequence"][min(old.count(ep),len(v["sequence"])-1)]\nprint(json.dumps(v))\n')
  signer_code='import pathlib,json,sys,os\nr=pathlib.Path('+repr(str(self.root))+')\n(r/"signer.tmpdir").write_text(os.environ.get("TMPDIR",""))\nwith (r/"signer.calls").open("a")as f:f.write(json.dumps(sys.argv[1:])+"\\n")\nsys.exit(int((r/"signer.rc").read_text())if(r/"signer.rc").exists()else 0)\n'
  self.rs.write_text('#!/bin/bash\nexec /usr/bin/python3 -I -c '+shlex.quote(signer_code)+' "$@"\n')
  self.gh.chmod(0o700);self.rs.chmod(0o700)
 def tearDown(self):self.tmp.cleanup()
 def execute(self,original=False):
  (self.root/'fixtures.json').write_text(json.dumps(self.data))
  env={**os.environ,'RA_ROOT_SELFTEST':str(self.root),'RA_GH_SELFTEST':str(self.gh),'RA_RS_SELFTEST':str(self.rs),'TMPDIR':str(self.root)+'/inherited-noncanonical/'}
  script=(HERE/'fixtures/release-autorun-rev1.sh')if original else(HERE.parent/'release-autorun.sh')
  result=subprocess.run(['/bin/bash',str(script)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
  self.assertEqual(result.returncode,0,result.stderr.decode());return result
 def calls(self):
  p=self.root/'signer.calls';return [json.loads(x)for x in p.read_text().splitlines()]if p.exists()else[]
 def state(self,name):return self.root/'release-sign/autorun'/name
 def test_original_stale_first_counterfactual_and_fixed_exact_binding(self):
  self.execute(original=True);self.assertEqual(self.calls(),[]);self.assertTrue(self.state('attest-22-2.seen').exists())
  self.state('attest-22-2.seen').unlink();self.execute();calls=self.calls();self.assertEqual(len(calls),1)
  args=dict(zip(calls[0][::2],calls[0][1::2]));self.assertEqual(args,{'--tag':'v9.9.9','--head-sha':H,'--ci-run':'11','--ci-attempt':'2','--artifact-id':'102','--bundle-artifact-id':'202','--attestor-run':'22','--attestor-attempt':'2','--attestor-sha':A,'--audit-run':'33','--audit-attempt':'1'})
 def test_newer_noop_does_not_hide_older_ready_attestor_or_become_seen(self):
  newer=run(23,1,A,'attest-ci-build');self.data['repos/ashlrai/phantom/actions/runs/23']=newer
  self.data['repos/ashlrai/phantom/actions/runs/23/artifacts?per_page=100']=inventory([])
  self.data['repos/ashlrai/phantom/actions/workflows/attest-ci-build.yml/runs?status=success&per_page=20']={'total_count':2,'workflow_runs':[newer,self.data['repos/ashlrai/phantom/actions/runs/22']]}
  self.execute();self.assertEqual(len(self.calls()),1);self.assertFalse(self.state('attest-23-1.seen').exists())
 def test_missing_artifact_is_not_final_and_exact_later_readiness_can_proceed(self):
  key='repos/ashlrai/phantom/actions/runs/22/artifacts?per_page=100';ready=self.data.pop(key)
  self.execute();self.assertEqual(self.calls(),[]);self.assertFalse(self.state('attest-22-2.seen').exists())
  self.data[key]=ready;self.execute();self.assertEqual(len(self.calls()),1)
 def test_artifact_absence_does_not_write_terminal_state(self):
  self.data['repos/ashlrai/phantom/actions/runs/22/artifacts?per_page=100']=inventory([])
  self.execute();self.assertEqual(self.calls(),[]);self.assertEqual(list(self.state('.').glob('attest-*.seen')),[])
 def test_artifact_count_truncation_refuses(self):
  self.data['repos/ashlrai/phantom/actions/runs/22/artifacts?per_page=100']['total_count']=101
  self.execute();self.assertEqual(self.calls(),[]);self.assertFalse(self.state('attest-22-2.seen').exists())
 def test_duplicate_current_artifact_refuses(self):
  key='repos/ashlrai/phantom/actions/runs/22/artifacts?per_page=100';rows=self.data[key]['artifacts'];new=copy.deepcopy(rows[-1]);new['id']=203;rows.append(new);self.data[key]['total_count']=len(rows)
  self.execute();self.assertEqual(self.calls(),[])
 def test_foreign_artifact_run_refuses(self):
  self.data['repos/ashlrai/phantom/actions/runs/22/artifacts?per_page=100']['artifacts'][-1]['workflow_run']['id']=99
  self.execute();self.assertEqual(self.calls(),[])
 def test_foreign_artifact_source_refuses(self):
  self.data['repos/ashlrai/phantom/actions/runs/22/artifacts?per_page=100']['artifacts'][-1]['workflow_run']['head_sha']=H
  self.execute();self.assertEqual(self.calls(),[])
 def test_foreign_artifact_repository_refuses(self):
  self.data['repos/ashlrai/phantom/actions/runs/22/artifacts?per_page=100']['artifacts'][-1]['workflow_run']['repository_id']=1
  self.execute();self.assertEqual(self.calls(),[])
 def test_missing_digest_refuses(self):
  del self.data['repos/ashlrai/phantom/actions/runs/22/artifacts?per_page=100']['artifacts'][-1]['digest']
  self.execute();self.assertEqual(self.calls(),[])
 def test_expired_artifact_is_not_selected(self):
  self.data['repos/ashlrai/phantom/actions/runs/22/artifacts?per_page=100']['artifacts'][-1]['expired']=True
  self.execute();self.assertEqual(self.calls(),[]);self.assertFalse(self.state('attest-22-2.seen').exists())
 def test_changed_attestor_attempt_refuses_without_seen(self):
  self.data['repos/ashlrai/phantom/actions/runs/22']=copy.deepcopy(self.data['repos/ashlrai/phantom/actions/runs/22']);self.data['repos/ashlrai/phantom/actions/runs/22']['run_attempt']=3
  self.execute();self.assertEqual(self.calls(),[]);self.assertFalse(self.state('attest-22-2.seen').exists())
 def test_wrong_run_source_refuses(self):
  self.data['repos/ashlrai/phantom/actions/runs/11/attempts/2']['head_repository']={'id':1,'full_name':'other/repo'}
  self.execute();self.assertEqual(self.calls(),[])
 def test_duplicate_producer_artifact_refuses(self):
  key='repos/ashlrai/phantom/actions/runs/11/artifacts?per_page=100';rows=self.data[key]['artifacts'];new=copy.deepcopy(rows[-1]);new['id']=103;rows.append(new);self.data[key]['total_count']=len(rows)
  self.execute();self.assertEqual(self.calls(),[])
 def test_master_moves_before_intent_refuses(self):
  self.data['repos/ashlrai/phantom/commits/master']={'sequence':[{'sha':A},{'sha':H}]}
  self.execute();self.assertEqual(self.calls(),[]);self.assertFalse(self.state('sha-'+H+'.started').exists())
 def test_started_without_completion_is_held_without_any_network_or_overwrite(self):
  marker=self.state('sha-'+H+'.started');marker.write_bytes(b'original intent\n');before=marker.stat()
  self.execute();self.assertEqual(self.calls(),[]);self.assertFalse((self.root/'gh.calls').exists());self.assertEqual(marker.read_bytes(),b'original intent\n');self.assertEqual(marker.stat().st_ino,before.st_ino)
 def test_all_completed_outcomes_remain_final_without_automatic_retry(self):
  for rc in [0,4,5,12,14,16]:
   with self.subTest(rc=rc):
    self.state('sha-'+H+'.started').write_text('original\n');self.state('sha-'+H+'.rc').write_text(str(rc)+'\n');self.execute();self.assertEqual(self.calls(),[])
 def test_successful_once_per_source_is_not_repeated(self):
  self.execute();self.execute();self.assertEqual(len(self.calls()),1)
 def test_stop_is_untouched_and_blocks_before_network(self):
  marker=self.root/'RELEASE_AUTORUN_OFF';marker.write_bytes(b'owned stop\n');self.execute();self.assertEqual(marker.read_bytes(),b'owned stop\n');self.assertEqual(self.calls(),[]);self.assertFalse((self.root/'gh.calls').exists())
 def test_signer_uses_only_canonical_supported_tmpdir_input(self):
  self.execute();self.assertEqual(len(self.calls()),1);self.assertEqual((self.root/'signer.tmpdir').read_text(),'/private/tmp')
 def test_existing_keychain_gate_remains(self):
  (self.root/'release-sign/keychain-allowed').unlink();self.execute();self.assertEqual(self.calls(),[]);self.assertTrue((self.root/'release-sign/NEEDS-MASON-v9.9.9').exists());self.assertFalse(self.state('sha-'+H+'.started').exists())
if __name__=='__main__':unittest.main(verbosity=2)
