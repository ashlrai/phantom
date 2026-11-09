import copy,hashlib,json,os,pathlib,shlex,subprocess,tempfile,unittest
HERE=pathlib.Path(__file__).resolve().parent
A='a'*40; H='b'*40; REPO={'id':1263526319,'full_name':'ashlrai/phantom'}
V='9.9.9'; TAG='v'+V; BASE='https://github.com/ashlrai/phantom/releases/download/'+TAG+'/'
APP_NAME='Phantom_'+V+'_aarch64.app.tar.gz'; CLI_NAME='ashlr-phantom-'+V+'.tgz'
APP_SHA='d'*64; CLI_SHA='e'*64; CLISIG_SHA='f'*64
MSIG='untrusted comment: signature from minisign secret key\nRUFTQkdNRVItMS1mYWtlLW1hbmlmZXN0LXNpZwo='
APPSIG='untrusted comment: signature from minisign secret key\nRUFTQkdBUFAtMS1mYWtlLWFwcC1zaWcK'
MANIFEST={'schemaVersion':2,'kind':'phantom-paired-release','version':V,'source':{'revision':H},
 'app':{'filename':APP_NAME,'url':BASE+APP_NAME,'sha256':APP_SHA},
 'cli':{'filename':CLI_NAME,'url':BASE+CLI_NAME,'sha256':CLI_SHA}}
MANIFEST_TEXT=json.dumps(MANIFEST,sort_keys=True,separators=(',',':'))
FEED={'version':V,'platforms':{'darwin-aarch64':{'url':BASE+APP_NAME,'signature':APPSIG}},'phantom':{'manifestText':MANIFEST_TEXT,'signature':MSIG}}
FEED_TEXT=json.dumps(FEED,sort_keys=True,separators=(',',':'))
def sha(text):return hashlib.sha256(text.encode()).hexdigest()
def relasset(aid,name,size,digest):return {'id':aid,'name':name,'state':'uploaded','size':size,'digest':'sha256:'+digest}
def release_assets():
 return [relasset(501,'latest.json',len(FEED_TEXT),sha(FEED_TEXT)),relasset(502,'manifest.json',len(MANIFEST_TEXT),sha(MANIFEST_TEXT)),
  relasset(503,'manifest.json.sig',len(MSIG),sha(MSIG)),relasset(504,APP_NAME+'.sig',len(APPSIG),sha(APPSIG)),
  relasset(505,APP_NAME,1234567,APP_SHA),relasset(506,CLI_NAME,7654321,CLI_SHA),relasset(507,CLI_NAME+'.sig',300,CLISIG_SHA)]
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
 'repos/ashlrai/phantom/tags?per_page=100':[{'name':TAG,'commit':{'sha':H}}],
 'repos/ashlrai/phantom/actions/workflows/dependency-audit.yml/runs?head_sha='+H+'&status=success&per_page=1':{'workflow_runs':[aud]},
 'repos/ashlrai/phantom/actions/runs/33':aud,
 'repos/ashlrai/phantom/releases/tags/'+TAG:{'id':77,'tag_name':TAG,'draft':False,'prerelease':False,'target_commitish':H},
 'repos/ashlrai/phantom/releases/77/assets?per_page=100':release_assets(),
 'repos/ashlrai/phantom/releases/assets/501':{'raw':FEED_TEXT},
 'repos/ashlrai/phantom/releases/assets/502':{'raw':MANIFEST_TEXT},
 'repos/ashlrai/phantom/releases/assets/503':{'raw':MSIG},
 'repos/ashlrai/phantom/releases/assets/504':{'raw':APPSIG},
 'repos/ashlrai/phantom/releases/latest':{'tag_name':TAG},
 }
class AutorunTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='autorun-fixture-');self.root=pathlib.Path(self.tmp.name);self.data=fixtures()
  (self.root/'bin').mkdir();(self.root/'release-sign/autorun').mkdir(parents=True)
  (self.root/'bin/scrub.pl').write_text('while (<STDIN>) { print; }\n')
  (self.root/'release-sign/keychain-allowed').touch()
  self.gh=self.root/'fake-gh';self.rs=self.root/'fake-signer';self.curl=self.root/'fake-curl'
  self.gh.write_text('#!/usr/bin/python3 -I\nimport pathlib,json,sys\nr=pathlib.Path('+repr(str(self.root))+')\na=sys.argv[1:]\nassert a[0]=="api" and not any(x in ("-X","--method","-f","-F","--input") for x in a)\nep=a[-1]\nlog=r/"gh.calls"\nold=log.read_text().splitlines() if log.exists() else []\nwith log.open("a")as f:f.write(ep+"\\n")\nd=json.loads((r/"fixtures.json").read_text())\nif ep not in d:sys.exit(2)\nv=d[ep]\nif isinstance(v,dict) and "sequence"in v:v=v["sequence"][min(old.count(ep),len(v["sequence"])-1)]\nif isinstance(v,dict) and "raw" in v:sys.stdout.write(v["raw"])\nelse:print(json.dumps(v))\n')
  signer_code='import pathlib,json,sys,os\nr=pathlib.Path('+repr(str(self.root))+')\n(r/"signer.tmpdir").write_text(os.environ.get("TMPDIR",""))\nwith (r/"signer.calls").open("a")as f:f.write(json.dumps(sys.argv[1:])+"\\n")\nsys.exit(int((r/"signer.rc").read_text())if(r/"signer.rc").exists()else 0)\n'
  self.rs.write_text('#!/bin/bash\nexec /usr/bin/python3 -I -c '+shlex.quote(signer_code)+' "$@"\n')
  curl_code='import pathlib,sys,shutil\nr=pathlib.Path('+repr(str(self.root))+')\na=sys.argv[1:]\nout=pathlib.Path(a[a.index("-o")+1])\nwith (r/"curl.calls").open("a")as f:f.write(a[-1]+"\\n")\ntry:shutil.copyfile(r/"curl.body",out)\nexcept OSError:pass\nsys.stdout.write((r/"curl.code").read_text().strip()if(r/"curl.code").exists()else"000")\n'
  self.curl.write_text('#!/usr/bin/python3 -I\n'+curl_code)
  self.gh.chmod(0o700);self.rs.chmod(0o700);self.curl.chmod(0o700)
  (self.root/'curl.code').write_text('200\n');(self.root/'curl.body').write_text(FEED_TEXT)
 def tearDown(self):self.tmp.cleanup()
 def execute(self,original=False):
  (self.root/'fixtures.json').write_text(json.dumps(self.data))
  env={**os.environ,'RA_ROOT_SELFTEST':str(self.root),'RA_GH_SELFTEST':str(self.gh),'RA_RS_SELFTEST':str(self.rs),'RA_CURL_SELFTEST':str(self.curl),'TMPDIR':str(self.root)+'/inherited-noncanonical/'}
  script=(HERE/'fixtures/release-autorun-rev1.sh')if original else(HERE.parent/'release-autorun.sh')
  result=subprocess.run(['/bin/bash',str(script)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
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
 def feed_rc(self):
  p=self.state('feed-'+H+'.rc');return p.read_text().strip()if p.exists()else None
 def feed_receipt(self):
  p=self.state('feed-'+H+'.json');return json.loads(p.read_text())if p.exists()else None
 def sign_once(self):
  self.execute();self.assertEqual(len(self.calls()),1);self.assertEqual(self.state('sha-'+H+'.rc').read_text().strip(),'0')
 def test_successful_signing_verifies_live_update_channel(self):
  self.sign_once();self.execute()
  self.assertEqual(self.feed_rc(),'0')
  receipt=self.feed_receipt();self.assertEqual(receipt['state'],'verified-live')
  self.assertEqual(receipt['endpointHttp'],200);self.assertEqual(receipt['tag'],TAG);self.assertEqual(receipt['sha'],H)
  self.assertEqual(receipt['releaseId'],77);self.assertEqual(receipt['feedSha256'],sha(FEED_TEXT))
  self.assertIn('FEED-OK '+TAG,(self.state('autorun.log')).read_text())
 def test_release_not_public_is_pending_then_verifies(self):
  key='repos/ashlrai/phantom/releases/tags/'+TAG; rel=self.data.pop(key)
  self.sign_once();self.execute();self.assertIsNone(self.feed_rc());self.assertIsNone(self.feed_receipt())
  self.data[key]=rel;self.execute();self.assertEqual(self.feed_rc(),'0')
 def test_signed_sha_tag_absent_after_signing_is_pending(self):
  self.sign_once();self.execute();self.assertEqual(self.feed_rc(),'0')
  self.state('feed-'+H+'.rc').unlink();self.state('feed-'+H+'.json').unlink()
  self.data['repos/ashlrai/phantom/tags?per_page=100']=[]
  self.execute();self.assertIsNone(self.feed_rc())
  self.assertFalse((self.root/('release-sign/NEEDS-MASON-'+TAG+'-feed')).exists())
 def test_incomplete_asset_set_is_final_failure_with_needs_note(self):
  self.data['repos/ashlrai/phantom/releases/77/assets?per_page=100']=[a for a in release_assets()if a['name']!='latest.json']
  self.sign_once();self.execute()
  self.assertEqual(self.feed_rc(),'22');self.assertEqual(self.feed_receipt()['reason'],'asset-set-incomplete')
  self.assertTrue((self.root/('release-sign/NEEDS-MASON-'+TAG+'-feed')).exists())
 def test_missing_asset_digest_is_pending_not_failed(self):
  rows=release_assets();rows[0]['digest']=None
  self.data['repos/ashlrai/phantom/releases/77/assets?per_page=100']=rows
  self.sign_once();self.execute();self.assertIsNone(self.feed_rc())
  self.assertFalse((self.root/('release-sign/NEEDS-MASON-'+TAG+'-feed')).exists())
 def test_feed_binding_mismatch_is_final_failure(self):
  self.data['repos/ashlrai/phantom/releases/assets/502']={'raw':'{"kind":"phantom-paired-release","version":"9.9.8"}'}
  self.sign_once();self.execute()
  self.assertEqual(self.feed_rc(),'22');self.assertEqual(self.feed_receipt()['reason'],'binding-failed')
 def test_release_identity_mismatch_is_final_failure(self):
  self.data['repos/ashlrai/phantom/releases/tags/'+TAG]['target_commitish']=A
  self.sign_once();self.execute()
  self.assertEqual(self.feed_rc(),'22');self.assertEqual(self.feed_receipt()['reason'],'release-inconsistent')
 def test_superseded_release_records_final_not_latest(self):
  self.data['repos/ashlrai/phantom/releases/latest']={'tag_name':'v9.9.10'}
  self.sign_once();self.execute()
  self.assertEqual(self.feed_rc(),'21')
  receipt=self.feed_receipt();self.assertEqual(receipt['state'],'superseded');self.assertEqual(receipt['latestTag'],'v9.9.10');self.assertIsNone(receipt['endpointHttp'])
  self.assertFalse((self.root/('release-sign/NEEDS-MASON-'+TAG+'-feed')).exists());self.assertFalse((self.root/'curl.calls').exists())
 def test_older_latest_is_final_failure(self):
  self.data['repos/ashlrai/phantom/releases/latest']={'tag_name':'v9.9.8'}
  self.sign_once();self.execute()
  self.assertEqual(self.feed_rc(),'22');self.assertEqual(self.feed_receipt()['reason'],'latest-mismatch')
 def test_endpoint_not_serving_is_pending_until_it_serves(self):
  (self.root/'curl.code').write_text('404\n')
  self.sign_once();self.execute();self.assertIsNone(self.feed_rc())
  (self.root/'curl.code').write_text('200\n');self.execute();self.assertEqual(self.feed_rc(),'0')
 def test_endpoint_bytes_mismatch_is_final_failure(self):
  (self.root/'curl.body').write_text('{"version":"9.9.9","platforms":{},"phantom":{}}')
  self.sign_once();self.execute()
  self.assertEqual(self.feed_rc(),'22');self.assertEqual(self.feed_receipt()['reason'],'endpoint-mismatch')
 def test_feed_failure_is_final_and_not_retried(self):
  self.data['repos/ashlrai/phantom/releases/77/assets?per_page=100']=[]
  self.sign_once();self.execute();self.assertEqual(self.feed_rc(),'22')
  before=(self.root/'gh.calls').read_text()
  self.data['repos/ashlrai/phantom/releases/77/assets?per_page=100']=release_assets()
  self.execute();self.assertEqual(self.feed_rc(),'22')
  self.assertEqual((self.root/'gh.calls').read_text().count('releases/'),before.count('releases/'))
 def test_failed_signing_never_runs_feed_check(self):
  (self.root/'signer.rc').write_text('5')
  self.execute();self.execute()
  calls=(self.root/'gh.calls').read_text()if(self.root/'gh.calls').exists()else''
  self.assertNotIn('releases/',calls);self.assertIsNone(self.feed_rc());self.assertFalse((self.root/'curl.calls').exists())
 def test_verified_feed_outcome_is_not_recursed(self):
  self.sign_once();self.execute();self.assertEqual(self.feed_rc(),'0')
  before=(self.root/'gh.calls').read_text()
  self.execute();self.assertEqual(self.feed_rc(),'0')
  self.assertEqual((self.root/'gh.calls').read_text().count('releases/'),before.count('releases/'))
if __name__=='__main__':unittest.main(verbosity=2)
