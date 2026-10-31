#!/usr/bin/env python3
"""publish.sh git-safe rev4 tests (test copies of publish.sh rewrite only the literal fork URL prefix to a local bare dir). Real git + linked worktree, local bare 'fork', stub gh, real scrub.pl."""
import hashlib, os, subprocess, tempfile, unittest
import sys
# ---- rev4.1 test hygiene: inherited git env cannot steer the suite; every temp dir lives under one root removed at exit
import atexit as _ax, shutil as _sh, signal as _sg, tempfile as _tf
for _k in list(os.environ):
    if _k.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")) or _k in ("GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
            "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG", "GIT_DIR", "GIT_WORK_TREE"): del os.environ[_k]
_TMPROOT = os.path.realpath(_tf.mkdtemp(prefix="gs-suite-")); _tf.tempdir = _TMPROOT; os.environ["TMPDIR"] = _TMPROOT
_ax.register(_sh.rmtree, _TMPROOT, True)
for _s in (_sg.SIGTERM, _sg.SIGHUP): _sg.signal(_s, lambda *_: (_ for _ in ()).throw(SystemExit(1)))
def _inherited_env_check(tc, test_id):   # rerun one happy-path test in a child that inherits hostile GIT_CONFIG_*/GIT_DIR env
    if os.environ.get("_GS_CHILD"): tc.skipTest("child")
    import subprocess as _sp
    can = os.path.join(_TMPROOT, "ENVCANARY"); hk = can + ".sh"
    with open(hk, "w") as f: f.write("#!/bin/sh\ntouch %s\n" % can)
    os.chmod(hk, 0o755)
    env = dict(os.environ, _GS_CHILD="1", GIT_CONFIG_COUNT="2", GIT_CONFIG_KEY_0="core.fsmonitor", GIT_CONFIG_VALUE_0=hk,
               GIT_CONFIG_KEY_1="core.hooksPath", GIT_CONFIG_VALUE_1="/nonexistent", GIT_CONFIG_PARAMETERS="'core.fsmonitor'='%s'" % hk,
               GIT_DIR="/nonexistent/.git", GIT_WORK_TREE="/nonexistent")
    r = _sp.run([sys.executable, os.path.abspath(__file__), test_id], env=env, capture_output=True, text=True, timeout=600)
    tc.assertEqual(r.returncode, 0, r.stderr[-3000:]); tc.assertIn("OK", r.stderr); tc.assertFalse(os.path.exists(can), "inherited env executed")
HERE = os.path.dirname(os.path.realpath(__file__)); SCRIPT_SRC = os.environ.get("PUBLISH", os.path.join(HERE, "publish.sh")); SCRIPT = None
GITSAFE_SRC = os.environ.get("GITSAFE_SRC", os.path.join(HERE, "git-safe-env.sh"))
R_ENV = os.environ.get("R") or os.path.expanduser("~/.ashlr-runs")
def _scrub():   # env, else the repo copy found by walking up from this file, else $R/bin
    if os.environ.get("SCRUB_PL"): return os.environ["SCRUB_PL"]
    d = HERE
    while d != os.path.dirname(d):
        c = os.path.join(d, "contrib", "mac-bridge", "scrub.pl")
        if os.path.exists(c): return c
        d = os.path.dirname(d)
    return os.path.join(R_ENV, "bin", "scrub.pl")
SCRUB = _scrub()
PIN = "credential.https://github.com.helper=!/opt/homebrew/bin/gh auth git-credential"
GENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}

class T(unittest.TestCase):
    def setUp(self):
        self.h = os.path.realpath(tempfile.mkdtemp()); self.R = self.h + "/.ashlr-runs"; st = self.h + "/stub"
        for d in (self.R + "/bin", self.h + "/Projects/ashlrai/wt", st): os.makedirs(d)
        self.w(self.R + "/bin/git-safe-env.sh", open(GITSAFE_SRC).read(), 0o755); self.w(self.R + "/bin/scrub.pl", open(SCRUB).read(), 0o755)
        self.w(st + "/gh", '#!/bin/bash\necho "gh $*" >> %s/gh.log\nfor a in "$@"; do printf "%%s\\n" "$a"; done >> %s/gh-argv.log\ncase "$1 $2" in "pr create") echo https://github.com/ashlrai/phantom/pull/42;; "repo view") [ "$3" = "--json" ] && echo main || true; [ "${4:-}" = "--json" ] && echo main; exit 0;; esac\nexit 0\n' % (self.h, self.h), 0o755)
        self.w(self.h + "/.gitconfig", "[user]\n\tname = t\n\temail = t@t\n")
        self.main = self.h + "/Projects/ashlrai/phantom"; os.makedirs(self.main); os.makedirs(self.h + "/forks"); self.fork = self.h + "/forks/phantom.git"
        global SCRIPT; SCRIPT = self.h + "/publish-test.sh"
        self.w(SCRIPT, open(SCRIPT_SRC).read().replace('FORK_URL="https://github.com/masonwyatt23/', 'FORK_URL="%s/forks/' % self.h, 1), 0o755)
        self.git(self.main, "init", "-q"); self.w(self.main + "/a.txt", "a\n"); self.git(self.main, "add", "-A"); self.git(self.main, "commit", "-qm", "b")
        self.git(self.main, "remote", "add", "origin", "https://github.com/ashlrai/phantom.git"); subprocess.run(["git", "init", "-q", "--bare", self.fork], check=True)
        self.env = {"HOME": self.h, "PATH": st + ":/usr/bin:/bin", "LANG": "C"}; self.canary = self.h + "/CANARY"
    def w(self, p, s, mode=None):
        with open(p, "w") as f: f.write(s)
        if mode: os.chmod(p, mode)
    def git(self, d, *a): return subprocess.run(["git", "-C", d, *a], check=True, capture_output=True, text=True, env=dict(os.environ, HOME=self.h, **GENV)).stdout.strip()
    def job(self, j, tail="some title"):
        wt = self.h + "/Projects/ashlrai/wt/" + j; self.git(self.main, "worktree", "add", "-q", "-b", "codex-bridge/" + j, wt, "HEAD")
        os.makedirs(self.R + "/queue/run", exist_ok=True); self.w("%s/queue/run/%s.line" % (self.R, j), "%s\tphantom\tcodex-cmp\twork\t%s\n" % (j, tail))
        self.w("%s/%s.base" % (self.R, j), "%s codex-bridge/%s %s codex\n" % (self.git(wt, "rev-parse", "HEAD"), j, wt)); return wt
    def prompt(self, j, line):   # the verbatim queue line launch froze into the prompt, then RULES
        self.w("%s/%s.prompt" % (self.R, j), "Job %s (pool codex-cmp, tier work, repo phantom). Task verbatim:\n\n%s\n\nTreat the task as the minimum.\n" % (j, line))
    def title_of(self):          # exact argv element handed to --title (one arg per line in gh-argv.log)
        a = [l for l in open(self.h + "/gh-argv.log").read().split("\n") if l]; return a[len(a) - a[::-1].index("--title")]
    def run_(self, j):
        r = subprocess.run(["nice", "-n", "10", "bash", SCRIPT, j], env=self.env, capture_output=True, text=True, timeout=120)
        return open("%s/%s.publish" % (self.R, j)).read()
    def plant(self, wt):
        self.git(self.main, "config", "filter.evil.clean", "touch %s; cat" % self.canary); self.w(wt + "/.gitattributes", "* filter=evil\n")

    def test_clean_change_publishes(self):
        wt = self.job("J1"); self.w(wt + "/b.txt", "new\n"); self.w(wt + "/BRIDGE_NOTES.md", "# did b\n")
        out = self.run_("J1"); self.assertIn("RESULT PR https://github.com/ashlrai/phantom/pull/42", out, out)
        self.assertIn("codex-bridge/J1", subprocess.run(["git", "-C", self.fork, "branch"], capture_output=True, text=True).stdout)

    def test_no_change_empty(self):
        self.job("J1"); out = self.run_("J1"); self.assertIn("RESULT EMPTY", out, out)

    def test_planted_filter_aborts_no_canary(self):
        wt = self.job("J1"); self.w(wt + "/b.txt", "new\n"); self.plant(wt)
        out = self.run_("J1"); self.assertIn("RESULT ABORT git-unsafe git_config_unsafe", out, out)
        self.assertFalse(os.path.exists(self.canary)); self.assertEqual(self.git(wt, "rev-parse", "HEAD"), self.git(self.main, "rev-parse", "HEAD"))
        self.assertFalse(os.path.exists(self.h + "/gh.log"))

    def test_fsmonitor_and_attribute_only(self):
        wt = self.job("J1"); self.w(self.canary + ".sh", "#!/bin/sh\ntouch %s\n" % self.canary, 0o755)
        self.git(self.main, "config", "core.fsmonitor", self.canary + ".sh"); self.assertIn("RESULT ABORT git-unsafe", self.run_("J1"))
        self.git(self.main, "config", "--unset", "core.fsmonitor"); self.w(wt + "/.gitattributes", "x filter=lfs\n")
        self.assertIn("RESULT ABORT git-unsafe attributes_filter", self.run_("J1")); self.assertFalse(os.path.exists(self.canary))

    def test_tampered_helper_aborts(self):
        wt = self.job("J1"); self.w(wt + "/b.txt", "n\n"); self.w(self.R + "/bin/git-safe-env.sh", "#!/bin/bash\n", 0o755)
        self.assertIn("RESULT ABORT git-safe-unavailable", self.run_("J1"))

    def test_env_injection_neutralized(self):
        wt = self.job("J1"); self.w(self.canary + ".sh", "#!/bin/sh\ntouch %s\n" % self.canary, 0o755)
        self.env.update(GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="core.fsmonitor", GIT_CONFIG_VALUE_0=self.canary + ".sh")
        self.assertIn("RESULT EMPTY", self.run_("J1")); self.assertFalse(os.path.exists(self.canary))   # rev4.1 B2: neutralized, correct result

    # ---- rev2 (Masbot): push never loads ~/.gitconfig; credential pinned by fixed -c
    def traced(self):   # test-only copies: helper's fixed git -> argv-logging wrapper of /usr/bin/git, publish pin moved to match
        lg = self.h + "/argv.log"; wr = self.h + "/gitwrap"
        self.w(wr, '#!/bin/bash\nprintf "%%s\\0" "$@" >> %s; printf "\\n" >> %s\nexec /usr/bin/git "$@"\n' % (lg, lg), 0o755)
        hs = open(GITSAFE_SRC).read().replace("GS_GIT_FIXED=/usr/bin/git", "GS_GIT_FIXED=" + wr, 1)
        self.w(self.R + "/bin/git-safe-env.sh", hs, 0o755)
        ps = open(SCRIPT).read().replace(hashlib.sha256(open(GITSAFE_SRC, "rb").read()).hexdigest(), hashlib.sha256(hs.encode()).hexdigest())
        self.tscript = self.h + "/publish-traced.sh"; self.w(self.tscript, ps, 0o755); return lg
    def pushes(self, lg): return [l.split("\0")[:-1] for l in open(lg).read().split("\n") if "push" in l.split("\0")]

    def test_rev2_push_argv_credential_pinned_exactly(self):
        lg = self.traced(); wt = self.job("J1"); self.w(wt + "/b.txt", "new\n")
        global SCRIPT; old = SCRIPT; SCRIPT = self.tscript
        try: out = self.run_("J1")
        finally: SCRIPT = old
        self.assertIn("RESULT PR", out, out); p = self.pushes(lg); self.assertEqual(len(p), 1, p); a = p[0]
        cfg = [a[i + 1] for i, x in enumerate(a[:-1]) if x == "-c"]; cred = [c for c in cfg if c.lower().startswith("credential")]
        self.assertEqual(cred, ["credential.helper=", PIN], a)
        self.assertLess(a.index("credential.helper="), a.index(PIN))

    def test_rev2_planted_home_gitconfig_not_honored_on_push(self):
        wt = self.job("J1"); self.w(wt + "/b.txt", "new\n"); evil = self.h + "/evil.git"; subprocess.run(["git", "init", "-q", "--bare", evil], check=True)
        self.w(self.canary + ".sh", "#!/bin/sh\ntouch %s\n" % self.canary, 0o755)
        self.w(self.h + "/.gitconfig", "[user]\n\tname = t\n\temail = t@t\n[credential]\n\thelper = !%s.sh\n[filter \"evil\"]\n\tclean = %s.sh\n\tsmudge = %s.sh\n"
               "[core]\n\tfsmonitor = %s.sh\n\tattributesFile = %s/attrs\n[url \"%s\"]\n\tpushInsteadOf = %s\n" % (self.canary, self.canary, self.canary, self.canary, self.h, evil, self.fork))
        self.w(self.h + "/attrs", "* filter=evil\n")
        out = self.run_("J1"); self.assertIn("RESULT PR", out, out)
        self.assertFalse(os.path.exists(self.canary), "planted ~/.gitconfig value executed")
        self.assertIn("codex-bridge/J1", subprocess.run(["git", "-C", self.fork, "branch"], capture_output=True, text=True).stdout)
        self.assertEqual(subprocess.run(["git", "-C", evil, "branch"], capture_output=True, text=True).stdout, "")   # pushInsteadOf ignored

    def test_rev2_no_workspace_literals_and_pin(self):
        for f in (SCRIPT_SRC, __file__): self.assertNotIn("/" + "workspace", open(f).read())
        self.assertIn(hashlib.sha256(open(GITSAFE_SRC, "rb").read()).hexdigest(), open(SCRIPT_SRC).read())

    # ---- rev3 (Security P1): literal fork URL, NAME/REPO from the job record only
    def branches(self, d): return subprocess.run(["git", "-C", d, "branch"], capture_output=True, text=True).stdout
    def test_rev3_named_remote_decoy_ignored(self):
        wt = self.job("J1"); self.w(wt + "/b.txt", "new\n"); decoy = self.h + "/decoy.git"; subprocess.run(["git", "init", "-q", "--bare", decoy], check=True)
        self.git(self.main, "remote", "add", "fork", "https://github.com/ashlrai/phantom.git")   # passes gs_check url allowlist: the org repo
        self.git(self.main, "remote", "set-url", "origin", "https://github.com/ashlrai/locus.git")   # origin lies about the repo
        out = self.run_("J1"); self.assertIn("RESULT PR", out, out)
        self.assertIn("codex-bridge/J1", self.branches(self.fork)); self.assertEqual(self.branches(decoy), "")
        self.assertIn("--repo ashlrai/phantom", open(self.h + "/gh.log").read()); self.assertNotIn("ashlrai/locus", open(self.h + "/gh.log").read())
    def test_rev3_pushurl_or_bad_url_refused(self):
        wt = self.job("J1"); self.w(wt + "/b.txt", "new\n")
        self.git(self.main, "config", "remote.fork.pushurl", "https://github.com/ashlrai/phantom.git")
        self.assertIn("RESULT ABORT git-unsafe git_config_unsafe:pushurl", self.run_("J1"))   # rev4.1 reason name
        self.git(self.main, "config", "--unset", "remote.fork.pushurl"); self.git(self.main, "config", "remote.fork.url", self.h + "/decoy.git")
        self.assertIn("RESULT ABORT git-unsafe git_config_unsafe:remote_url", self.run_("J1")); self.assertEqual(self.branches(self.fork), "")
    def test_rev3_name_not_allowlisted_aborts(self):
        wt = self.job("J1"); self.w(wt + "/b.txt", "new\n"); self.w(self.R + "/queue/run/J1.line", "J1\tevilrepo\tcodex-cmp\twork\n")
        self.assertIn("RESULT ABORT repo-not-allowlisted", self.run_("J1")); self.assertFalse(os.path.exists(self.h + "/gh.log"))
    def test_rev3_record_mismatch_aborts(self):
        wt = self.job("J1"); self.w(wt + "/b.txt", "new\n"); self.w(self.R + "/queue/run/J1.line", "J2\tphantom\tcodex-cmp\twork\n")
        self.assertIn("RESULT ABORT job-record-mismatch", self.run_("J1"))
        os.remove(self.R + "/queue/run/J1.line"); self.assertIn("RESULT ABORT no-job-record", self.run_("J1"))
        os.symlink(self.h + "/x", self.R + "/queue/run/J1.line"); self.assertIn("RESULT ABORT no-job-record", self.run_("J1"))
    def test_rev3_repo_mismatch_aborts(self):
        wt = self.job("J1"); self.w(wt + "/b.txt", "new\n"); os.makedirs(self.h + "/Projects/ashlrai/locus/.git")
        self.w(self.R + "/queue/run/J1.line", "J1\tlocus\tcodex-cmp\twork\n")
        self.assertIn("RESULT ABORT repo-mismatch", self.run_("J1")); self.assertEqual(self.branches(self.fork), "")
    def test_rev3_push_target_is_literal_url(self):
        src = open(SCRIPT_SRC).read(); self.assertIn('FORK_URL="https://github.com/masonwyatt23/$NAME.git"', src)
        self.assertIn('push -q --no-verify "$FORK_URL"', src); self.assertNotIn("remote get-url", src); self.assertNotIn("remote add", src)

    # ---- rev4 (Security): push pins http transport keys; empty extraHeader really resets (unscoped + url-scoped)
    HTTP_PIN = ["http.sslVerify=true", "http.proxy=", "http.extraHeader=", "http.https://github.com/.sslVerify=true",
                "http.https://github.com/.proxy=", "http.https://github.com/.extraHeader="]
    def test_rev4_push_argv_http_pinned(self):
        lg = self.traced(); wt = self.job("J1"); self.w(wt + "/b.txt", "new\n")
        global SCRIPT; old = SCRIPT; SCRIPT = self.tscript
        try: out = self.run_("J1")
        finally: SCRIPT = old
        self.assertIn("RESULT PR", out, out); a = self.pushes(lg)[0]
        cfg = [a[i + 1] for i, x in enumerate(a[:-1]) if x == "-c"]
        self.assertEqual([c for c in cfg if c.lower().startswith("http")], self.HTTP_PIN, a); self.assertLess(a.index(self.HTTP_PIN[-1]), a.index("push"))
    def test_rev4_planted_http_keys_abort_before_push(self):
        for k, v in (("http.https://github.com/.proxy", "http://127.0.0.1:9"), ("http.sslVerify", "false"), ("http.extraHeader", "X-Evil: 1")):
            wt = self.job("J" + str(len(k))); self.w(wt + "/b.txt", "new\n"); self.git(self.main, "config", k, v)
            self.assertIn("RESULT ABORT git-unsafe git_config_unsafe:http.", self.run_("J" + str(len(k))), k); self.git(self.main, "config", "--unset", k)
        self.assertEqual(self.branches(self.fork), "")
    def test_rev4_empty_extraheader_resets_list(self):   # real http: the push's -c set, github prefix pointed at a local server
        import http.server, threading, shlex
        seen = []
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(s): seen.append(sorted(k for k in s.headers.keys() if k.lower().startswith("x-"))); s.send_response(404); s.end_headers()
            def log_message(s, *a): pass
        srv = http.server.HTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start(); base = "http://127.0.0.1:%d/" % srv.server_port
        line = [l for l in open(SCRIPT_SRC).read().replace("\\\n", " ").splitlines() if " push -q " in l][0]
        toks = shlex.split(line.split(" push -q ")[0]); cfg = [toks[i + 1].replace("https://github.com/", base) for i, x in enumerate(toks) if x == "-c"]
        self.git(self.main, "config", "--add", "http.extraHeader", "X-A: 1"); self.git(self.main, "config", "--add", "http.extraHeader", "X-B: 2")
        self.git(self.main, "config", "http.%s.extraHeader" % base, "X-C: 3")
        def ls(c): subprocess.run(["git", "-C", self.main, *sum((["-c", x] for x in c), []), "ls-remote", base + "x"], capture_output=True, env=dict(os.environ, HOME=self.h, GIT_TERMINAL_PROMPT="0"), timeout=30)
        ls([]); ls(cfg); srv.shutdown()
        self.assertEqual(seen[0], ["X-A", "X-B", "X-C"], seen); self.assertTrue(len(seen) >= 2 and all(s == [] for s in seen[1:]), seen)

    def test_rev41_mac_clone_no_push_publishes(self):   # origin https url + pushurl=no_push, as on every Mac clone
        wt = self.job("J1"); self.w(wt + "/b.txt", "new\n"); self.git(self.main, "config", "remote.origin.pushurl", "no_push")
        out = self.run_("J1"); self.assertIn("RESULT PR", out, out); self.assertIn("codex-bridge/J1", self.branches(self.fork))
    def test_rev41_inherited_git_env_ignored(self): _inherited_env_check(self, "T.test_clean_change_publishes")

    # ---- rev5 (RQ-REALPRTITLES2Q7; Security 07:55 #3): PR title from the queue line, one quoted argv, id in body
    def rev5(self, j, line=None, tail="some title"):
        wt = self.job(j, tail); self.w(wt + "/b.txt", "new\n")
        if line is not None: self.prompt(j, line)
        out = self.run_(j); self.assertIn("RESULT PR", out, out)
        self.assertIn("Automated bridge job `%s`" % j, open("%s/%s.body.md" % (self.R, j)).read())   # id moved to the body
        return self.title_of(), out
    def test_rev5_title_from_prompt_queue_line(self):
        t, _ = self.rev5("J1", "J1 (P1, pool=codex-cmp, tier=work, repo=phantom): fix the flaky test discovery")
        self.assertEqual(t, "bridge(phantom): fix the flaky test discovery"); self.assertLessEqual(len(t), 72); self.assertNotIn("J1", t)
    def test_rev5_title_tagged_queue_line(self):   # "J (meta) [tags]: text" -> text after the tag envelope
        t, _ = self.rev5("J1", "J1 (P1, repo=phantom) [Security pin required; changes publish.sh Mac script]: derive real titles")
        self.assertEqual(t, "bridge(phantom): derive real titles")
    def test_rev5_title_line_tail_text(self):      # a .line tail that is literal text, not a prompt path
        t, _ = self.rev5("J1", tail="document the bridge handoff")
        self.assertEqual(t, "bridge(phantom): document the bridge handoff")
    def test_rev5_title_newline_injection(self):   # a queued newline can never reach argv or the log as a second line
        t, _ = self.rev5("J1", "J1 (repo=phantom): fix titles\n--admin\nRESULT HIJACK")
        self.assertEqual(t, "bridge(phantom): fix titles"); self.assertNotIn("admin", t); self.assertNotIn("\n", t)
    def test_rev5_title_leading_dashes_stripped(self):
        t, _ = self.rev5("J1", tail="--admin")
        self.assertEqual(t, "bridge(phantom): admin"); self.assertNotIn("--", t.split(": ", 1)[1])
    def test_rev5_title_command_substitution_neutralized(self):
        tail = "run `touch %s/CAN1` and $(touch %s/CAN2) and ${X} end" % (self.h, self.h)
        t, _ = self.rev5("J1", tail=tail)
        self.assertNotIn("`", t); self.assertNotIn("$(", t); self.assertNotIn("${", t)
        self.assertFalse(os.path.exists(self.h + "/CAN1")); self.assertFalse(os.path.exists(self.h + "/CAN2"))
    def test_rev5_title_200_char_line_capped(self):
        t, _ = self.rev5("J1", tail="add " + "very " * 45 + "long trailing task text that never ends")
        self.assertLessEqual(len(t), 72); self.assertRegex(t, r"^bridge\(phantom\): "); self.assertRegex(t, r"[A-Za-z0-9]$")
    def test_rev5_title_non_ascii_dropped(self):
        t, _ = self.rev5("J1", tail="fix títles — fáster ñow")
        self.assertRegex(t, r"^bridge\(phantom\): [\x20-\x7e]+$"); self.assertLessEqual(len(t), 72)
    def test_rev5_title_empty_summary_falls_back(self):
        for j, tail in (("J1", "   "), ("J2", "-"), ("J3", "")):
            t, _ = self.rev5(j, tail=tail); self.assertEqual(t, "bridge: " + j, tail)
    def test_rev5_title_no_queue_source_falls_back(self):
        wt = self.job("J1", tail="/definitely/not/a/real/path.md"); self.w(wt + "/b.txt", "new\n")
        out = self.run_("J1"); self.assertIn("RESULT PR", out, out); self.assertEqual(self.title_of(), "bridge: J1")
    def test_rev5_pr_create_argv_fully_quoted(self):
        line = [l for l in open(SCRIPT_SRC).read().splitlines() if "gh pr create" in l][0]
        for tok in ('--repo "$REPO"', '--head "masonwyatt23:codex-bridge/$J"', '--base "$DEF"',
                    '--title "$TITLE"', '--body-file "$R/$J.body.md"'):
            self.assertIn(tok, line)
        src = open(SCRIPT_SRC).read(); code = "\n".join(l for l in src.splitlines() if not l.lstrip().startswith("#"))
        self.assertNotIn("eval", code); self.assertNotIn("sh -c", code)
    def test_rev5_gates_and_refs_unchanged(self):
        src = open(SCRIPT_SRC).read()
        for keep in ('FORK_URL="https://github.com/masonwyatt23/$NAME.git"', 'push -q --no-verify "$FORK_URL"',
                     "$SHA:refs/heads/codex-bridge/$J", "RESULT DENIED", "g1-pass-invalid", "AUTO_MERGE"):
            self.assertIn(keep, src)
        self.assertIn("masonwyatt23:codex-bridge/$J", [l for l in src.splitlines() if "gh pr create" in l][0])

if __name__ == "__main__": unittest.main(verbosity=2)
