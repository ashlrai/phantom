#!/usr/bin/env python3
"""Fresh kernel pressure check immediately before an unreserved native spawn.

Exit 0 permits, 3 holds. No state is written and no worker is signalled.
"""
import os
import platform
import subprocess
import sys

# Isolated mode excludes the script directory; import only its sibling module.
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from host_session_observation import _bounded


def allowed(system, run):
    if system != 'Darwin':
        return True
    try:
        value = run(['/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level'])
        return value.strip() == '1'
    except (OSError, ValueError, TimeoutError, UnicodeError, subprocess.SubprocessError):
        return False


def probe(command):
    return _bounded(command, timeout=2, limit=32)


def main():
    return 0 if allowed(platform.system(), probe) else 3


if __name__ == '__main__':
    raise SystemExit(main())
