"""Current claims have a bounded lifecycle; archived history cannot poison liveness."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'contrib/mac'))
import host_session_runtime as runtime
import host_session_tick as tick

class ClaimLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.runs=Path(self.tmp.name).resolve();self.run=self.runs/'queue/run';self.run.mkdir(parents=True)
        self.boot=lambda:'same-current-boot'
        self.other={'pid':999999,'ppid':1,'start':'other-start','uid':os.getuid(),'rssBytes':1,'cpuPercent':0}
    def register(self,job,pid):
        owner=self.run/(job+'.root-owner');owner.mkdir();(owner/'owner.json').write_text(json.dumps({'owner':'same-owner'}))
        row=dict(self.other,pid=pid,start='birth-'+str(pid))
        claim=runtime.register_claim(str(self.runs),job,pid,boot=self.boot,census=lambda:[row,self.other])
        return claim,row
    def reconcile(self,rows=None,**kwargs):
        return runtime.reconcile_closed_claims(str(self.runs),boot=kwargs.pop('boot',self.boot),census=kwargs.pop('census',lambda:rows or [self.other]),**kwargs)
    def path(self,job):return self.run/'resource-sessions'/(job+'.json')
    def test_more_than_256_historical_jobs_leave_the_live_claim_and_exact_history(self):
        originals={}
        for i in range(300):
            job='RQ-old-'+str(i);claim,_=self.register(job,1000+i);originals[job]=claim
        live,row=self.register('RQ-live',10)
        self.assertEqual(self.reconcile([row,self.other]),300)
        self.assertEqual(runtime.read_claims(str(self.runs)),[live])
        for job,claim in originals.items():
            archived=self.run/'resource-sessions/history'/(job+'.'+claim['ownerNonce']+'.json')
            self.assertEqual(json.loads(archived.read_text()),claim)
        self.assertEqual(self.reconcile([row,self.other]),0)
        self.assertTrue(runtime.verify_current_claim(str(self.runs),live))
    def ordinary_register(self,job,pid):
        root=self.runs/'Projects/ashlrai/wt';tree=root/job;tree.mkdir(parents=True)
        (tree/'file').write_bytes(b'x'*4096)
        (self.runs/(job+'.base')).write_text('a'*40+' codex-bridge/'+job+' '+str(tree)+' codex\n')
        (self.run/(job+'.line')).write_text(job+'\tphantom\tcodex\twork\tprompt\n')
        (self.run/(job+'.dispatched')).write_text('1234567890')
        row=dict(self.other,pid=pid,start='birth-'+str(pid))
        claim=runtime.register_claim(str(self.runs),job,pid,boot=self.boot,census=lambda:[row,self.other],worktree_root=str(root))
        return claim,row,tree
    def test_mixed_settled_and_live_preserves_real_default_live_disk_and_sessions(self):
        with patch.dict(os.environ,{'HOME':str(self.runs)}):
            self.ordinary_register('RQ-old',11);live,row,tree=self.ordinary_register('RQ-live',10)
            (self.run/'RQ-old.dispatched').unlink();(self.run/'RQ-old.rc').write_text('0\n')
            result=tick.tick(str(self.runs),boot=self.boot,census=lambda:[row,self.other],pressure=lambda:{'state':'normal','level':1},now=1000)
            self.assertEqual([x['jobId']for x in result['sessions']],['RQ-live'])
            self.assertEqual(result['sessions'][0]['state'],'known')
            self.assertEqual(result['disk']['state'],'history');self.assertGreater(result['disk']['allocatedBytes'],0)
            self.assertEqual(runtime.verified_worktrees(str(self.runs)),[{'job':'RQ-live','path':str(tree)}])
            self.assertFalse(self.path('RQ-old').exists());self.assertTrue(self.path('RQ-live').exists())
    def test_reaped_attempt_absence_does_not_poison_current_inventory(self):
        old,_,tree=self.ordinary_register('RQ-reaped',10)
        (self.runs/'RQ-reaped.base').unlink();(self.run/'RQ-reaped.dispatched').unlink();shutil.rmtree(tree)
        self.assertEqual(self.reconcile(),1)
        self.assertFalse(self.path('RQ-reaped').exists())
        self.assertEqual(runtime.read_claims(str(self.runs)),[])
    def test_changed_closed_records_are_preserved_but_complete_reap_absence_can_retire(self):
        _,_,tree=self.ordinary_register('RQ-old',10)
        (self.run/'RQ-old.dispatched').unlink();(self.run/'RQ-old.rc').write_text('0\n')
        (self.run/'RQ-old.line').write_text('RQ-old\tchanged\tcodex\twork\tprompt\n')
        self.assertEqual(self.reconcile(),0);self.assertTrue(self.path('RQ-old').exists())
        (self.runs/'RQ-old.base').unlink();(self.run/'RQ-old.line').unlink();shutil.rmtree(tree)
        self.assertEqual(self.reconcile(),1);self.assertFalse(self.path('RQ-old').exists())
    def test_active_pid_reuse_or_partial_census_never_retires(self):
        claim,row=self.register('RQ-live',10);raw=self.path('RQ-live').read_bytes()
        self.assertEqual(self.reconcile([dict(row,start='reused'),self.other]),0)
        snapshots=iter([[row,self.other],[self.other]])
        self.assertEqual(self.reconcile(census=lambda:next(snapshots)),0)
        for census in [lambda:[],lambda:[{'pid':10}]]:
            with self.assertRaises(ValueError):self.reconcile(census=census)
        self.assertEqual(self.path('RQ-live').read_bytes(),raw)
        self.assertTrue(runtime.verify_current_claim(str(self.runs),claim))
    def test_boot_and_protected_owner_changes_never_retire(self):
        self.register('RQ-old',10);raw=self.path('RQ-old').read_bytes()
        boots=iter(['before','after'])
        with self.assertRaises(ValueError):self.reconcile(boot=lambda:next(boots))
        count=0
        def census():
            nonlocal count
            count+=1
            if count==1:(self.run/'RQ-old.root-owner/owner.json').write_text(json.dumps({'owner':'changed'}))
            return [self.other]
        self.assertEqual(self.reconcile(census=census),0)
        self.assertEqual(self.path('RQ-old').read_bytes(),raw)
    def test_claim_cas_and_directory_swap_refuse_before_current_unlink(self):
        self.register('RQ-old',10);original=self.path('RQ-old').read_bytes();write=runtime.write_json_at
        def changed(directory,name,value):
            write(directory,name,value)
            if name.startswith('RQ-old.'):
                claim=json.loads(original);claim['ownerNonce']='f'*64
                self.path('RQ-old').write_text(json.dumps(claim))
        with patch.object(runtime,'write_json_at',side_effect=changed):self.assertEqual(self.reconcile(),0)
        self.assertTrue(self.path('RQ-old').exists())
        # Restore the exact record then replace the private directory during observation.
        self.path('RQ-old').write_bytes(original);count=0;directory=self.run/'resource-sessions'
        def census():
            nonlocal count
            count+=1
            if count==1:
                directory.rename(self.run/'relocated');directory.mkdir(mode=0o700)
            return [self.other]
        with self.assertRaises(ValueError):self.reconcile(census=census)
        self.assertEqual((self.run/'relocated/RQ-old.json').read_bytes(),original)
    def test_unknown_legacy_or_malformed_registration_provenance_stays_current_unknown(self):
        self.register('RQ-old',10);path=self.path('RQ-old');claim=json.loads(path.read_text())
        for pins in [None, {'base':None,'line':None,'dispatched':None,'owner':['invalid']}]:
            changed=dict(claim)
            if pins is None:changed.pop('registrationPins')
            else:changed['registrationPins']=pins
            path.write_text(json.dumps(changed));before=path.read_bytes()
            self.assertEqual(self.reconcile(),0);self.assertEqual(path.read_bytes(),before)

    def test_registration_and_retirement_share_the_same_nonblocking_directory_lock(self):
        self.register('RQ-old',10)
        def census():
            with self.assertRaisesRegex(ValueError,'registration busy'):
                runtime.register_claim(str(self.runs),'RQ-old',11,boot=self.boot,census=lambda:[self.other])
            return [self.other]
        self.assertEqual(self.reconcile(census=census),1)
    def test_retirement_is_bounded_and_converges_without_counting_history(self):
        for i in range(12):self.register('RQ-old-'+str(i),i+10)
        with patch.object(runtime,'MAX_RECONCILE_CLAIMS',5):
            self.assertEqual(self.reconcile(),5);self.assertEqual(self.reconcile(),5);self.assertEqual(self.reconcile(),2)
        self.assertEqual(runtime.read_claims(str(self.runs)),[])

if __name__=='__main__':unittest.main()
