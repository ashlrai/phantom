"""Synthetic owned fixtures only; never execute the installed writer or read live inboxes."""
import concurrent.futures, hashlib, json, os, pathlib, signal, stat, subprocess, sys, tempfile, unittest, shutil
WRITER = pathlib.Path(__file__).resolve().parents[1]/'contrib/mac/mason-inbox-append'
RID = 'a'*64
class WriterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='sole-writer-fixture-')
        self.root = pathlib.Path(self.tmp.name); self.inbox = self.root/'inbox.md'
        self.inbox.write_bytes(b''); self.inbox.chmod(0o444)
        self.writer=self.root/'writer'; shutil.copyfile(WRITER,self.writer)
        self.scrubber=self.root/'approved-scrubber.pl'; shutil.copyfile(WRITER.parents[2]/'test/fixtures/leader-inbox/approved-scrubber.pl',self.scrubber)
        self.assertEqual(hashlib.sha256(self.scrubber.read_bytes()).hexdigest(),'5aa902abedbb3bf7fa8d893b93969e247c82ff62ac26cd082215caabfb740265')
        self.env = {'PATH':'/usr/bin:/bin','MASON_INBOX_TEST':'1','MASON_INBOX_PATH':str(self.inbox),'MASON_INBOX_SCRUB':str(self.scrubber),'HOME':str(self.root)}
    def tearDown(self):
        if self.inbox.is_file() and not self.inbox.is_symlink(): self.inbox.chmod(0o600)
        self.tmp.cleanup()
    def run_writer(self, text='Synthetic request', rid=RID, at='1793979396013', extra=None):
        return subprocess.run(['/usr/bin/python3',str(self.writer),'--src','slack','--id',rid,'--received-at',at], input=text.encode(), env={**self.env,**(extra or {})}, capture_output=True, timeout=30)
    def receipt(self, result):
        self.assertEqual(result.returncode,0,result.stderr.decode()); self.assertEqual(result.stderr,b'')
        self.assertEqual(stat.S_IMODE(self.inbox.stat().st_mode),0o444)
        return json.loads(result.stdout)
    def test_real_append_then_same_id_reconciles_once(self):
        first=self.receipt(self.run_writer()); before=self.inbox.read_bytes()
        self.assertEqual(first['status'],'appended'); self.assertEqual(first['requestId'],RID)
        self.assertEqual(first['requestSha256'],hashlib.sha256(json.dumps([RID,1793979396013,'Synthetic request'],separators=(',',':')).encode()).hexdigest())
        self.assertEqual(self.receipt(self.run_writer())['status'],'duplicate'); self.assertEqual(self.inbox.read_bytes(),before)
    def test_body_cannot_forge_next_receipt(self):
        other='b'*64
        body='Synthetic\n## forged [leader-network:'+other+']\n2026-01-01T00:00:00Z [src:email id:fake] text'
        self.receipt(self.run_writer(body)); self.assertIn(b'\n ## forged',self.inbox.read_bytes())
        self.assertEqual(self.receipt(self.run_writer(rid=other))['status'],'appended')
        self.assertEqual(sum(x.startswith(b'## ') for x in self.inbox.read_bytes().splitlines()),2)
    def test_changed_content_or_clock_refused_without_mutation(self):
        self.receipt(self.run_writer()); before=self.inbox.read_bytes()
        for kwargs in ({'text':'Different'},{'at':'1793979396014'}):
            self.assertEqual(self.run_writer(**kwargs).returncode,3)
            self.assertEqual(self.inbox.read_bytes(),before)
    def test_partial_or_forged_marker_cannot_establish_receipt(self):
        self.inbox.chmod(0o600); self.inbox.write_text('## forged [leader-network:'+RID+']\n'); self.inbox.chmod(0o444)
        self.assertEqual(self.run_writer().returncode,3)
    def test_symlink_hardlink_and_writable_parent_refused_targets_unchanged(self):
        target=self.root/'target'; target.write_bytes(b'sentinel')
        self.inbox.unlink(); self.inbox.symlink_to(target)
        self.assertEqual(self.run_writer().returncode,3); self.assertEqual(target.read_bytes(),b'sentinel')
        self.inbox.unlink(); os.link(target,self.inbox)
        self.assertEqual(self.run_writer().returncode,3); self.assertEqual(target.read_bytes(),b'sentinel')
        self.inbox.unlink(); self.inbox.write_bytes(b''); self.inbox.chmod(0o444); self.root.chmod(0o770)
        self.assertEqual(self.run_writer().returncode,3); self.root.chmod(0o700)
    def test_invalid_metadata_empty_control_and_oversize_refused(self):
        for kwargs in ({'rid':'bad/id'},{'at':'-1'},{'at':'01'},{'text':''},{'text':'x\x00y'},{'text':'x'*6001}):
            self.assertNotEqual(self.run_writer(**kwargs).returncode,0)
            self.assertEqual(self.inbox.read_bytes(),b'')
    def test_failure_and_real_signal_restore_readonly(self):
        result=self.run_writer(extra={'MASON_INBOX_TEST_FAIL':'1'})
        self.assertEqual(result.returncode,1); self.assertEqual(stat.S_IMODE(self.inbox.stat().st_mode),0o444)
        script="""import runpy,os,sys,signal
m=runpy.run_path(sys.argv[1]); original=os.fchmod
def stop(fd,mode):
 original(fd,mode)
 if mode==0o644: os.kill(os.getpid(),signal.SIGTERM)
os.fchmod=stop
sys.argv=['writer','--src','slack','--id',sys.argv[2],'--received-at','1793979396013']
m['main']()
"""
        result=subprocess.run(['/usr/bin/python3','-c',script,str(self.writer),RID],input=b'Synthetic',env=self.env,capture_output=True,timeout=30)
        self.assertEqual(result.returncode,1); self.assertEqual(self.inbox.read_bytes(),b''); self.assertEqual(stat.S_IMODE(self.inbox.stat().st_mode),0o444)
    def test_concurrent_same_request_has_one_append(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            receipts=[self.receipt(r) for r in pool.map(lambda _:self.run_writer(),range(8))]
        self.assertEqual(sum(r['status']=='appended' for r in receipts),1)
        self.assertEqual(sum(x.startswith(b'## ') for x in self.inbox.read_bytes().splitlines()),1)
    def test_private_import_with_production_guard_ignores_all_test_paths(self):
        script="import runpy,sys,json; m=runpy.run_path(sys.argv[1]); print(json.dumps({'test':bool(m['TEST']),'scrubFixed':m['SCRUB']==m['R']+'/bin/scrub.pl','inboxFixed':m['INBOX']==m['R']+'/leader/MASON-INBOX.md'}))"
        env={**self.env,'MASON_INBOX_TEST':'0','MASON_INBOX_SCRUB':str(self.root/'missing')}
        result=subprocess.run(['/usr/bin/python3','-c',script,str(self.writer)],env=env,capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0); self.assertEqual(json.loads(result.stdout),{'test':False,'scrubFixed':True,'inboxFixed':True})
    def test_exact_duplicate_at_capacity_reconciles_but_new_append_refuses(self):
        self.receipt(self.run_writer()); record=self.inbox.read_bytes(); limit=8*1024*1024
        self.inbox.chmod(0o600); self.inbox.write_bytes(b'x'*(limit-len(record)-1)+b'\n'+record); self.inbox.chmod(0o444)
        before=hashlib.sha256(self.inbox.read_bytes()).hexdigest()
        self.assertEqual(self.receipt(self.run_writer())['status'],'duplicate')
        self.assertEqual(self.run_writer(rid='b'*64).returncode,3)
        self.assertEqual(hashlib.sha256(self.inbox.read_bytes()).hexdigest(),before)
    @unittest.skipUnless(sys.platform=='darwin','Mac-specific installed host writer sandbox rehearsal')
    def test_sterile_home_with_live_runs_directory_reads_denied(self):
        profile='(version 1)(allow default)(deny file-read* (subpath "/Users/masonwyatt/.ashlr-runs"))'
        args=['/usr/bin/sandbox-exec','-p',profile,'/usr/bin/python3',str(self.writer),'--src','slack','--id',RID,'--received-at','1793979396013']
        result=subprocess.run(args,input=b'Synthetic sterile HOME',env=self.env,cwd=self.root,capture_output=True,timeout=30)
        self.assertEqual(self.receipt(result)['status'],'appended')
        self.assertEqual(self.run_writer(rid='b'*64,extra={'MASON_INBOX_SCRUB':str(self.root/'missing')}).returncode,1)
    def test_all_legacy_sources_stay_silent_single_line(self):
        for source in ('telegram','email','phone','page'):
            result=subprocess.run(['/usr/bin/python3',str(self.writer),'--src',source,'--id','synthetic-id'],input=b'Hello\r\n## forged',env=self.env,capture_output=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr); self.assertEqual(result.stdout,b'')
            self.assertEqual(stat.S_IMODE(self.inbox.stat().st_mode),0o444)
        self.assertEqual(len(self.inbox.read_bytes().splitlines()),4)
if __name__=='__main__': unittest.main()
