"""Hermetic exercise of the candidate launcher branch and existing requeue block.

This deliberately executes source excerpts, not the complete dispatcher tick.
"""
import glob
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / 'contrib/mac/host-integration'
SPEC = importlib.util.spec_from_file_location('pressure', ROOT / 'contrib/mac/host_pressure_admission.py')
pressure = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pressure)

class NativeBlocks(unittest.TestCase):
    def test_gate_and_real_devin_branch_then_existing_requeue(self):
        source = (HOST / 'launch.candidate.sh').read_text()
        branch = next(line for line in source.splitlines() if line.startswith(' devin)'))
        dispatcher = (HOST / 'dispatchd.candidate.py').read_text()
        block = dispatcher.split('# ---- per-job launch outcome (requeue PAUSED/HELD launches)\n', 1)[1].split('# REV1G:', 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); run = root/'queue/run'; run.mkdir(parents=True)
            binpath = root/'bin'; binpath.mkdir()
            provider = binpath/'sandbox-exec'
            provider.write_text('#!/bin/sh\necho called >> "$CALLS"\n'); provider.chmod(0o755)
            (root/'job.prompt').write_text('synthetic')
            calls = root/'calls'
            def attempt(level):
                result = pressure.allowed('Darwin', lambda _: str(level))
                script = f'''#!/bin/bash\nR={root!s}; J=job; POOL=devin; M=fake; SCRUB=cat; E=(); export CALLS={calls!s}; export PATH={binpath!s}:$PATH
rcw() {{ :; }}
native_pressure_ok() {{ {'return 0' if result else 'echo "HELD: fresh kernel pressure unavailable or unsafe"; return 3'}; }}
case "$POOL" in
{branch}
esac
wait
'''
                return subprocess.run(['/bin/bash'], input=script, text=True, capture_output=True, timeout=5)
            self.assertTrue(pressure.allowed('Darwin', lambda _: '1'))
            late = attempt('2'); self.assertEqual(late.returncode, 3); self.assertFalse(calls.exists())
            (root/'job.launch').write_text(late.stdout)
            (run/'job.line').write_text('job\trepo\tdevin\twork\tprompt\n')
            (run/'job.dispatched').write_text('1')
            def rd(path):
                try: return Path(path).read_text()
                except OSError: return ''
            events=[]
            context=dict(glob=glob, os=os, re=re, RUN=str(run), R=str(root), alive=set(), rd=rd, ev=events.append)
            exec(block, context)
            self.assertEqual(context['requeue'], ['job\trepo\tdevin\twork\tprompt'])
            self.assertFalse((run/'job.dispatched').exists())
            self.assertEqual(attempt('1').returncode, 0)
            self.assertEqual(calls.read_text().splitlines(), ['called'])
            for value in ('2', '4', '0', 'bad'):
                self.assertFalse(pressure.allowed('Darwin', lambda _, v=value: v))
            self.assertTrue(pressure.allowed('Linux', lambda _: 'bad'))

if __name__ == '__main__': unittest.main()

class FullLauncher(unittest.TestCase):
    def test_full_devin_launcher_with_fake_kernel_and_provider(self):
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp); runs=home/'.ashlr-runs'; bins=runs/'bin'; bins.mkdir(parents=True)
            (runs/'queue/run').mkdir(parents=True)
            wt=home/'Projects/ashlrai/wt/job'; wt.mkdir(parents=True); (wt/'.git').write_text('synthetic')
            repo=home/'Projects/ashlrai/repo'; repo.mkdir(parents=True)
            shutil.copy(ROOT/'contrib/mac/host_pressure_admission.py', bins)
            shutil.copy(ROOT/'contrib/mac/host_session_observation.py', bins)
            (bins/'scrub.pl').write_text('while (<STDIN>) { print; }\n')
            fake=home/'fake'; fake.mkdir()
            git=fake/'git'; git.write_text('#!/bin/sh\ncase "$*" in *rev-parse*) echo 0123456789012345678901234567890123456789;; esac\n'); git.chmod(0o755)
            sandbox=fake/'sandbox-exec'; sandbox.write_text(f'#!/bin/sh\necho called >> {home}/calls\n'); sandbox.chmod(0o755)
            shim=home/'python-shim.py'; shim.write_text('''import os,runpy,sys,platform
args=sys.argv[1:]
if args and args[0]=='-I': args=args[1:]
if args and args[0].endswith('host_pressure_admission.py'):
 sys.path.insert(0,os.path.dirname(args[0])); import host_session_observation
 host_session_observation._bounded=lambda *a,**kw: os.environ['FAKE_PRESSURE']
 platform.system=lambda: 'Darwin'; sys.argv=args; runpy.run_path(args[0],run_name='__main__')
elif args and args[0].endswith('host_session_tick.py'): sys.exit(1)
else: os.execv('/usr/bin/python3',['/usr/bin/python3']+sys.argv[1:])
''')
            candidate=(HOST/'launch.candidate.sh').read_text()
            # Instrument only command locations to substitute fake git/kernel/provider.
            candidate=candidate.replace('export PATH="/opt/homebrew/bin:',f'export PATH="{fake}:/opt/homebrew/bin:')
            candidate=candidate.replace('/usr/bin/python3 -I "$f"',f'/usr/bin/python3 {shim} -I "$f"')
            candidate=candidate.replace('/usr/bin/python3 -I "$R/bin/host_session_tick.py"',f'/usr/bin/python3 {shim} -I "$R/bin/host_session_tick.py"')
            launch=home/'launch.sh'; launch.write_text(candidate)
            calls=home/'calls'; env=dict(os.environ,HOME=str(home),USER='synthetic',CALLS=str(calls),FAKE_PRESSURE='2')
            def invoke():
                return subprocess.run(['/bin/bash',str(launch),'job','repo','devin','work'],input='synthetic',text=True,env=env,capture_output=True,timeout=15)
            held=invoke(); self.assertEqual(held.returncode,3,held.stdout+held.stderr); self.assertIn('HELD:',held.stdout); self.assertFalse(calls.exists())
            env['FAKE_PRESSURE']='1'; result=invoke(); self.assertEqual(result.returncode,0,result.stdout+result.stderr); self.assertIn('launched job devin pid ',result.stdout)
            import time
            for _ in range(100):
                if calls.exists(): break
                time.sleep(0.02)
            self.assertEqual(calls.read_text().splitlines(),['called'])
            (runs/'HOLD').write_text('devin\n'); held=invoke(); self.assertIn('HELD: launches paused',held.stdout); self.assertEqual(calls.read_text().splitlines(),['called'])
