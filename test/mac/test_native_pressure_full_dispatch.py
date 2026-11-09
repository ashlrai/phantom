"""Entire captured dispatcher ticks call the entire candidate launcher, hermetically.

Only OS/provider/tool transports are substituted. Queue selection, grace, deferred
requeue, cancellation, registration and fixed-file writer are the actual source.
No provider, network, active fleet or credential path is accessed.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2]
HOST = SOURCE / 'contrib/mac/host-integration'

class ImmediateProcess:
    def __init__(self, output=''):
        self.returncode = 0
        self.pid = 99999999
        self.output = output
    def communicate(self, **_): return self.output, ''

class FullDispatch(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name).resolve()
        self.runs = self.home/'.ashlr-runs'
        self.bins = self.runs/'bin'; self.bins.mkdir(parents=True)
        self.queue = self.runs/'queue'; self.run_dir = self.queue/'run'; self.run_dir.mkdir(parents=True)
        self.job = 'RQ-synthetic-pressure'
        self.worktree = self.home/'Projects/ashlrai/wt'/self.job
        self.worktree.mkdir(parents=True); (self.worktree/'.git').write_text('synthetic git locator')
        (self.home/'Projects/ashlrai/repo').mkdir()
        self.prompt = self.queue/'prompts'/self.job
        self.prompt.parent.mkdir(); self.prompt.write_text('Inspect source.ts, synthetic source task only')
        self.line = '\t'.join([self.job, 'repo', 'devin', 'work', str(self.prompt), 'pin'])
        (self.queue/'ready.tsv').write_text(self.line+'\n')
        (self.queue/'router-queue.md').write_text('# synthetic, no remote tasks\n')
        (self.queue/'keep.txt').write_text(self.job+'\n')
        for marker in ['RESTOCK_OFF', 'LOADGATE_OFF', 'ROUTER_OFF']: (self.queue/marker).touch()
        for marker in ['LOADGATE_TEST', 'DISKGUARD_TEST']: (self.runs/marker).touch()
        slots = {'hard_cap': 30}
        for lane in ['codex-cmp','codex-personal','claude','devin','claude-api','codex-local','gemini','zai','agy','grok','cursor']:
            slots[lane] = {'target': int(lane == 'devin'), 'floor': 0, 'ceiling': int(lane == 'devin'), 'hard_cap': 30,
                           'held': lane != 'devin', 'last_change': time.time()}
        (self.queue/'slots.json').write_text(json.dumps(slots))
        (self.runs/'models.json').write_text(json.dumps({'devin.work': 'synthetic'}))
        metrics = self.runs/'metrics'; metrics.mkdir(); (metrics/'.outcomes.stamp').touch()
        for name in ['host_pressure_admission.py','host_session_observation.py','host_session_runtime.py','host_session_disk_cache.py','host_session_tick.py']:
            shutil.copy2(SOURCE/'contrib/mac'/name,self.bins/name)
        # Pure current source reader and router, not a new controller implementation.
        # Routing is explicitly OFF in this fixture. Only pure metadata dependencies
        # are stubbed; the complete actual dispatcher selection remains intact.
        (self.bins/'router_queue.py').write_text('from pathlib import Path\ndef load(path): return {}, []\ndef read_metadata(path): return Path(path).read_text()\n')
        (self.bins/'router.py').write_text('def load(queue): return {}, {}\n')
        self.fake = self.home/'fake'; self.fake.mkdir()
        self.calls = self.home/'provider-calls'
        executable = self.fake/'git'
        executable.write_text('#!/bin/sh\ncase "$*" in *rev-parse*) echo 0123456789012345678901234567890123456789;; esac\n'); executable.chmod(0o755)
        executable = self.fake/'sandbox-exec'
        executable.write_text('#!/bin/sh\necho called >> "$HOME/provider-calls"\n'); executable.chmod(0o755)
        (self.bins/'scrub.pl').write_text('while (<STDIN>) { print; }\n')
        self.shim = self.home/'reader-shim.py'
        self.shim.write_text('''import json,os,platform,runpy,sys
args=sys.argv[1:]
if args and args[0]=='-I':args=args[1:]
sys.path.insert(0,os.environ['HOME']+'/.ashlr-runs/bin')
import host_session_runtime as runtime,host_session_tick as tick
boot=lambda:'11111111-1111-1111-1111-111111111111'
def census(pid):return [{'pid':pid,'ppid':1,'uid':os.getuid(),'start':'0000000000000000000000000000000000000000000000000000000000000001','startSource':'ps-lstart','rssBytes':1024,'cpuPercent':10}]
if args[0].endswith('host_pressure_admission.py'):
 import host_pressure_admission as admission
 platform.system=lambda:'Darwin';admission.probe=lambda _:open(os.environ['HOME']+'/kernel-pressure').read().strip();sys.exit(admission.main())
elif args[0].endswith('host_session_tick.py'):
 runs=os.environ['HOME']+'/.ashlr-runs'
 if args[1]=='register':runtime.register_claim(runs,args[2],int(args[3]),boot=boot,census=lambda:census(int(args[3])));sys.exit(0)
 claims=runtime.read_claims(runs) if os.path.isdir(runs+'/queue/run/resource-sessions') else []
 rows=[row for claim in claims for row in census(claim['rootPid'])] or census(123456)
 tick.tick(runs,boot=boot,census=lambda:rows,pressure=lambda:{'state':'normal','level':1},roots_provider=lambda _:[]);sys.exit(0)
raise RuntimeError('unexpected inspection transport')
''')
        candidate = (HOST/'launch.candidate.sh').read_text()
        candidate = candidate.replace('export PATH="/opt/homebrew/bin:', f'export PATH="{self.fake}:/opt/homebrew/bin:')
        candidate = candidate.replace('/usr/bin/python3 -I "$f"', f'/usr/bin/python3 {self.shim} -I "$f"')
        candidate = candidate.replace('/usr/bin/python3 -I "$R/bin/host_session_tick.py"', f'/usr/bin/python3 {self.shim} -I "$R/bin/host_session_tick.py"')
        (self.bins/'launch.sh').write_text(candidate)
        self.dispatch = self.bins/'dispatchd.py'; self.dispatch.write_bytes((HOST/'dispatchd.candidate.py').read_bytes())
        self.children=[]; self.level='2'; self.selection='1'
    def tearDown(self):
        for child in self.children:
            if child.poll() is None: child.wait(timeout=5)
        self.temporary.cleanup()
    def tick(self):
        (self.home/'kernel-pressure').write_text(self.level)
        original_popen = subprocess.Popen
        def popen(command, *args, **kwargs):
            if command[:2] == ['/bin/bash',str(self.bins/'launch.sh')]:
                child = original_popen(command,*args,**kwargs); self.children.append(child); return child
            if len(command)>2 and command[1]=='-I' and command[2]==str(self.bins/'host_session_tick.py'):
                env = dict(kwargs.get('env',{}),HOME=str(self.home),FAKE_PRESSURE=self.level)
                return original_popen(['/usr/bin/python3',str(self.shim)]+command[1:],*args,**dict(kwargs,env=env))
            if command[:3]==['ashlr','daemon','status']:return ImmediateProcess(json.dumps({'lastTickAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}))
            if command[0]=='git':return ImmediateProcess('')
            raise AssertionError('unexpected executable '+repr(command))
        def run(command, **_):
            if command[0]=='memory_pressure':output='free percentage: 80'
            elif command[0]=='sysctl':output='used = 0M'
            elif command[0]=='ps':output=''
            elif str(command[-1]).endswith('autopilot.py'):output=json.dumps({'lane_disk_gate':'green','memory':{'known':True,'raise_ok':True}})
            elif any(str(x).endswith(('claude-api.py','use-it-all.py')) for x in command):output='{}'
            else:raise AssertionError('unexpected subprocess.run '+repr(command))
            return subprocess.CompletedProcess(command,0,output,'')
        snapshot=types.ModuleType('process_snapshot');snapshot.capture=lambda **_:subprocess.CompletedProcess([],0,'','')
        env=dict(HOME=str(self.home),USER='synthetic',LOGNAME='synthetic',PATH=str(self.fake)+':/usr/bin:/bin',FAKE_PRESSURE=self.level,LOADGATE_LOADAVG='0',LOADGATE_NCPU='18',DISKGUARD_FREE_GB='1000')
        # The actual pure router_queue source resolves from the synthetic fixed bin.
        before=list(sys.path);sys.path.insert(0,str(self.bins));saved={k:sys.modules.pop(k,None)for k in ['router_queue','host_session_observation']}
        try:
            import host_session_observation as observation
            original_pressure = observation.pressure_level
            observation.pressure_level = lambda: original_pressure('Darwin', lambda _: self.selection)
            with patch.dict(os.environ,env,clear=True),patch.dict(sys.modules,{'process_snapshot':snapshot}),patch.object(subprocess,'run',run),patch.object(subprocess,'Popen',popen),contextlib.redirect_stdout(io.StringIO()):
                runpy.run_path(str(self.dispatch),run_name='__main__')
        finally:
            sys.path[:]=before
            for k,v in saved.items():
                sys.modules.pop(k,None)
                if v is not None:sys.modules[k]=v
        for child in self.children:child.wait(timeout=10)
        return json.loads((self.queue/'status.json').read_text())
    def expire_grace(self):
        stamp=self.run_dir/(self.job+'.dispatched');os.utime(stamp,(time.time()-121,time.time()-121))
    def test_selection_then_late_pressure_then_normal_requeue_and_healthy_launch(self):
        first=self.tick();self.assertEqual(first['launched_this_tick'],[self.job])
        outcome=(self.runs/(self.job+'.launch')).read_text();self.assertTrue(outcome.startswith('HELD: fresh kernel pressure'),outcome);self.assertNotIn('Traceback',outcome);self.assertFalse(self.calls.exists())
        self.expire_grace();self.level='1';second=self.tick()
        self.assertEqual(second['launched_this_tick'],[self.job],(self.runs/'dispatch-events.log').read_text())
        outcome=(self.runs/(self.job+'.launch')).read_text();self.assertIn('launched '+self.job+' devin pid ',outcome,outcome)
        for _ in range(100):
            if self.calls.exists(): break
            time.sleep(0.02)
        self.assertEqual(self.calls.read_text().splitlines(),['called'])
        claim=self.run_dir/'resource-sessions'/(self.job+'.json');self.assertTrue(claim.exists())
        self.assertEqual(json.loads(claim.read_text())['jobId'],self.job)
        self.assertTrue((self.runs/'resource-session-observation.json').exists())
    def test_warning_at_selection_does_not_prepare_or_launch_a_job(self):
        self.selection='2';self.level='1';state=self.tick()
        self.assertEqual(state['launched_this_tick'],[]);self.assertFalse(self.calls.exists())
        self.assertFalse((self.runs/(self.job+'.base')).exists())
        self.assertIn('kernel pressure unavailable or unsafe', state['admission']['reason'])
        self.assertEqual((self.queue/'ready.tsv').read_text(),self.line+'\n')

    def test_cancelled_deferred_job_never_reaches_provider(self):
        self.tick();self.expire_grace();self.level='1';(self.queue/'RETIRED').write_text(self.job+'\n')
        second=self.tick();self.assertEqual(second['launched_this_tick'],[]);self.assertFalse(self.calls.exists())
        self.assertEqual((self.queue/'ready.tsv').read_text(),'')
        self.assertIn('SKIP_RETIRED '+self.job,(self.runs/'dispatch-events.log').read_text())

if __name__=='__main__':unittest.main()
