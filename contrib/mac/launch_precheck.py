"""Shared fail-open launch precheck; errors and usage never retire work."""
import os
import re
import signal
import subprocess


def run(cmd, timeout, **kwargs):
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         stdin=subprocess.DEVNULL, text=True, start_new_session=True, **kwargs)
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try: os.killpg(p.pid, signal.SIGKILL)
        except OSError: pass
        p.communicate()
        raise
    return subprocess.CompletedProcess(cmd, p.returncode, out, err)


def precheck(job, repo, prompt, home, runs, runner=run):
    try:
        task = next((t for t in prompt.splitlines() if t.startswith(job + " (")), "")
        if not task: return None
        env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG") if k in os.environ}
        env["GIT_TERMINAL_PROMPT"] = "0"
        r = runner(["/bin/bash", runs + "/bin/precheck.sh", task,
                    home + "/Projects/ashlrai/" + repo], 20, env=env, cwd=home)
        if r.returncode in (10, 11, 12, 13):
            m = re.search(r"reason=(\S+)", r.stdout)
            return (r.returncode, m.group(1) if m else "?")
    except Exception:
        pass
    return None


def attempt_identity(repo, prompt, home, runner=run):
    """Use the local upstream ref, without a fetch or a network call."""
    import hashlib
    try:
        result = runner(['git', '-C', home + '/Projects/ashlrai/' + repo,
                         'rev-parse', '--verify', 'refs/remotes/origin/HEAD^{commit}'], 2)
        sha = result.stdout.strip()
        if result.returncode or not re.fullmatch(r'[0-9a-f]{40,64}', sha): return {}
        return {'repo': repo, 'base_sha': sha,
                'prompt_hash': hashlib.sha256(prompt.encode()).hexdigest()}
    except Exception:
        return {}


def empty_reason(job, identity, rows, now):
    """Only successful empty finishes suppress work. Auth failures must retry.

    Claims bind each finish to its own attempt, so an older empty cannot mask
    a newer nonempty run. MERGED outcomes remain independently measurable.
    """
    from datetime import datetime
    if not identity: return None
    claims = {}; latest = {}
    for row in rows:
        if not isinstance(row, dict): continue
        key = row.get('job')
        if row.get('event') == 'claim': claims[key] = row
        if row.get('event') != 'finish': continue
        evidence = dict(claims.get(key, {}), **row)
        if evidence.get('repo') != identity['repo']: continue
        latest[key] = evidence
    for key, row in latest.items():
        if row.get('empty') is not True or row.get('exit_code') != 0: continue
        if row.get('base_sha') != identity['base_sha']: continue
        if key == job and job.startswith('RQ-UPKEEP-'): return 'upkeep_empty_same_base'
        try: age = now - datetime.fromisoformat(row['ts'].replace('Z', '+00:00')).timestamp()
        except (KeyError, ValueError, TypeError): continue
        if 0 <= age < 86400 and row.get('prompt_hash') == identity['prompt_hash']:
            return 'prompt_empty_same_base_24h'
    return None


def read_attempts(runs):
    import json
    rows = []
    try:
        with open(runs + '/metrics/jobs.jsonl') as stream:
            for line in stream:
                try: rows.append(json.loads(line))
                except ValueError: pass
    except OSError: pass
    return rows
