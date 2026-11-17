#!/usr/bin/python3
"""AUDIT-TAG-1 hermetic tests, ported for contrib/mac.
Runs contrib/mac/release-autorun.sh (and fixtures for contrast) with --selftest, a mocked gh that serves
fixture JSON by API path, and stub curl/release-sign. No network, no writes outside a temp dir.
Pass signal: autorun reaches the standing-authority / keychain-allowed gate and writes NEEDS-MASON-<tag>
(keychain-allowed is absent, so release-sign is never invoked). Fail signal: 'audit changed or invalid; held'."""
import json, os, shutil, subprocess, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
NEW = os.path.join(PKG, "release-autorun.sh")
BASE = os.path.join(HERE, "fixtures", "release-autorun-audit-tag-1.sh")
PRE = os.path.join(HERE, "fixtures", "release-autorun-pre-audit-tag.sh")
REPO = "repos/ashlrai/phantom"
RID = 1263526319
H = "88c42d1f31d92692f3c3f8b5d52ce203ba237f5e"   # release sha (v3.30.35 peeled)
M = "1111111111111111111111111111111111111111"   # master moved past H
X = "2222222222222222222222222222222222222222"   # some other sha
TAGOBJ = "3333333333333333333333333333333333333333"
TAG = "v3.30.35"
AR, AA, CI, CA, AU = 43940388273, 1, 43940000001, 1, 43942288322
REPOOBJ = {"id": RID, "full_name": "ashlrai/phantom"}

GH_STUB = r'''#!/bin/bash
echo "GH $*" >> "$(dirname "$0")/called"
for a in "$@"; do last="$a"; done
exec /usr/bin/python3 -I - "$(dirname "$0")/routes.json" "$last" <<'EOF'
import json,sys,os
routes=json.load(open(sys.argv[1])); p=sys.argv[2]
if p not in routes: sys.exit(1)
v=routes[p]
if isinstance(v,dict) and "__seq__" in v:
    cf=sys.argv[1]+".count"; n=int(open(cf).read()) if os.path.exists(cf) else 0
    open(cf,"w").write(str(n+1)); seq=v["__seq__"]; v=seq[min(n,len(seq)-1)]
if v is None: sys.exit(1)
print(json.dumps(v))
EOF
'''
FAIL_STUB = '#!/bin/bash\necho "$(basename "$0") $*" >> "$(dirname "$0")/called"\nexit 1\n'

def run_obj(rid, att, sha, branch, wf, event="push", conclusion="success", status="completed", repo=None):
    return {"id": rid, "run_attempt": att, "head_sha": sha, "head_branch": branch, "event": event,
            "path": ".github/workflows/%s.yml" % wf, "status": status, "conclusion": conclusion,
            "repository": repo or REPOOBJ, "head_repository": repo or REPOOBJ}

def compare(status="ahead"):
    return {"url": "https://api.github.com/%s/compare/%s...%s" % (REPO, H, M), "status": status,
            "truncated": False, "commits": [{}], "total_commits": 1}

def routes(audit, annotated=True, cmp_attest="ahead", cmp_audit=None):
    att = run_obj(AR, AA, H, TAG, "attest-ci-build")
    r = {
        REPO + "/commits/master": {"sha": M},
        REPO + "/actions/workflows/attest-ci-build.yml/runs?status=success&per_page=20": {"total_count": 1, "workflow_runs": [att]},
        REPO + "/actions/runs/%d" % AR: att,
        REPO + "/actions/runs/%d/artifacts?per_page=100" % AR: {"total_count": 1, "artifacts": [{"id": 9001, "name": "ashlr-attested-%d-%d-%d-%d" % (CI, CA, AR, AA), "expired": False, "digest": "sha256:" + "a" * 64, "workflow_run": {"id": AR, "head_sha": H, "repository_id": RID, "head_repository_id": RID}}]},
        REPO + "/actions/runs/%d/attempts/%d" % (CI, CA): run_obj(CI, CA, H, "master", "ci"),
        REPO + "/tags?per_page=100": [{"name": TAG, "commit": {"sha": H}}, {"name": "v3.30.34", "commit": {"sha": X}}],
        REPO + "/releases/latest": {"tag_name": "v3.30.33"},
        REPO + "/actions/runs/%d/artifacts?per_page=100" % CI: {"total_count": 1, "artifacts": [{"id": 9002, "name": "ashlr-build-%d-%d" % (CI, CA), "expired": False, "digest": "sha256:" + "b" * 64, "workflow_run": {"id": CI, "head_sha": H, "repository_id": RID, "head_repository_id": RID}}]},
        REPO + "/actions/workflows/dependency-audit.yml/runs?head_sha=%s&status=success&per_page=1" % H: {"total_count": 1, "workflow_runs": [{"id": AU, "run_attempt": 1}]},
        REPO + "/actions/runs/%d" % AU: audit,
    }
    if annotated:
        r[REPO + "/git/ref/tags/" + TAG] = {"object": {"type": "tag", "sha": TAGOBJ}}
        r[REPO + "/git/tags/" + TAGOBJ] = {"object": {"type": "commit", "sha": H}}
    else:
        r[REPO + "/git/ref/tags/" + TAG] = {"object": {"type": "commit", "sha": H}}
    ck = REPO + "/compare/%s...%s" % (H, M)
    if cmp_audit is None:
        r[ck] = compare(cmp_attest)
    else:  # call order: attest ancestry (139), audit ancestry (new 200), pre-signing (210)
        r[ck] = {"__seq__": [compare(cmp_attest), compare(cmp_audit), compare(cmp_audit)]}
    return r

def execute(script, rts):
    d = tempfile.mkdtemp(prefix="ra-audit-tag.")
    try:
        os.makedirs(d + "/stubs"); os.makedirs(d + "/bin"); os.makedirs(d + "/kill-dir")
        os.makedirs(d + "/release-sign/autorun")
        open(d + "/bin/scrub.pl", "w").write("while (<STDIN>) { print; }\n")
        open(d + "/release-sign/standing-authority", "w").write("STANDING-RELEASE-AUTHORITY rev1b fixture\n")
        open(d + "/stubs/gh", "w").write(GH_STUB)
        for n in ("curl", "release-sign.sh"): open(d + "/stubs/" + n, "w").write(FAIL_STUB)
        for n in ("gh", "curl", "release-sign.sh"): os.chmod(d + "/stubs/" + n, 0o700)
        json.dump(rts, open(d + "/stubs/routes.json", "w"))
        env = {"PATH": "/usr/bin:/bin", "RA_ROOT_SELFTEST": d, "RA_GH_SELFTEST": d + "/stubs/gh",
               "RA_RS_SELFTEST": d + "/stubs/release-sign.sh", "RA_CURL_SELFTEST": d + "/stubs/curl",
               "RA_KILL_SELFTEST": d + "/kill-dir/KILL"}
        p = subprocess.run(["/bin/bash", script, "--selftest"], env=env, capture_output=True, text=True, timeout=120)
        log = open(d + "/release-sign/autorun/autorun.log").read() if os.path.exists(d + "/release-sign/autorun/autorun.log") else ""
        called = open(d + "/stubs/called").read() if os.path.exists(d + "/stubs/called") else ""
        needs = os.path.exists(d + "/release-sign/NEEDS-MASON-" + TAG)
        return p.returncode, log, called, needs
    finally:
        shutil.rmtree(d, ignore_errors=True)

class AuditTag(unittest.TestCase):
    def ok(self, rts, script=NEW):
        rc, log, called, needs = execute(script, rts)
        self.assertEqual(rc, 0, log)
        self.assertTrue(needs, log)
        self.assertIn("NEEDS-MASON %s" % TAG, log)
        self.assertNotIn("audit changed or invalid", log)
        self.assertNotIn("release-sign.sh", called); self.assertNotIn("curl", called)
        return log

    def bad(self, rts, script=NEW, msg="audit changed or invalid; held"):
        rc, log, called, needs = execute(script, rts)
        self.assertEqual(rc, 0, log)
        self.assertFalse(needs, log)
        self.assertIn(msg, log)
        self.assertNotIn("release-sign.sh", called); self.assertNotIn("curl", called)
        return log

    # Contrast: the pre-AUDIT-TAG-1 file 350f87c8 still rejects a tag audit (the original bug).
    # Package base is now 742f0504, which already accepts that audit (test_01 and test_12).
    def test_00_base_rejects_tag_audit_the_bug(self):
        self.bad(routes(run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch")), script=PRE)
    def test_01_base_accepts_master_audit(self):
        self.ok(routes(run_obj(AU, 1, H, "master", "dependency-audit", "push")), script=BASE)

    # Security requirement 6
    def test_10_master_audit_passes(self):
        self.ok(routes(run_obj(AU, 1, H, "master", "dependency-audit", "push")))
    def test_11_master_schedule_audit_passes(self):
        self.ok(routes(run_obj(AU, 1, H, "master", "dependency-audit", "schedule")))
    def test_12_correct_tag_audit_passes_annotated(self):
        self.ok(routes(run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch"), annotated=True))
    def test_13_correct_tag_audit_passes_lightweight(self):
        self.ok(routes(run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch"), annotated=False))
    def test_20_wrong_tag_older_fails(self):
        self.bad(routes(run_obj(AU, 1, H, "v3.30.34", "dependency-audit", "workflow_dispatch")))
    def test_21_wrong_tag_rc_fails(self):
        self.bad(routes(run_obj(AU, 1, H, "v3.30.35-rc", "dependency-audit", "workflow_dispatch")))
    def test_22_glob_like_tag_fails(self):
        self.bad(routes(run_obj(AU, 1, H, "v3.30.*", "dependency-audit", "workflow_dispatch")))
    def test_23_refs_tags_prefix_fails(self):
        self.bad(routes(run_obj(AU, 1, H, "refs/tags/v3.30.35", "dependency-audit", "workflow_dispatch")))
    def test_30_tag_at_non_ancestor_sha_fails_at_attest(self):
        self.bad(routes(run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch"), cmp_attest="diverged"),
                 msg="not an ancestor of master")
    def test_31_tag_audit_ancestry_rechecked_fails_closed(self):
        self.bad(routes(run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch"), cmp_audit="diverged"))
    def test_32_tag_audit_compare_unreadable_fails_closed(self):
        r = routes(run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch"))
        r[REPO + "/compare/%s...%s" % (H, M)] = {"__seq__": [compare(), None, None]}
        self.bad(r)
    def test_33_tag_audit_compare_truncated_fails_closed(self):
        r = routes(run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch"))
        t = compare(); t["truncated"] = True
        r[REPO + "/compare/%s...%s" % (H, M)] = {"__seq__": [compare(), t, t]}
        self.bad(r)
    def test_40_non_success_audit_fails(self):
        self.bad(routes(run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch", conclusion="failure")))
    def test_41_incomplete_audit_fails(self):
        self.bad(routes(run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch", status="in_progress", conclusion=None)))
    def test_50_audit_head_sha_not_head_fails(self):
        self.bad(routes(run_obj(AU, 1, X, TAG, "dependency-audit", "workflow_dispatch")))
    def test_51_master_audit_head_sha_not_head_fails(self):
        self.bad(routes(run_obj(AU, 1, X, "master", "dependency-audit", "push")))
    def test_52_tag_peels_to_other_sha_fails(self):
        r = routes(run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch"))
        r[REPO + "/git/tags/" + TAGOBJ] = {"object": {"type": "commit", "sha": X}}
        self.bad(r, msg="not the peeled tag sha")
    def test_53_audit_sha_is_peeled_sha_of_other_tag_fails(self):
        self.bad(routes(run_obj(AU, 1, X, "v3.30.34", "dependency-audit", "workflow_dispatch")))
    # Requirement 4
    def test_60_pull_request_event_fails(self):
        self.bad(routes(run_obj(AU, 1, H, TAG, "dependency-audit", "pull_request")))
    def test_61_missing_event_fails(self):
        a = run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch"); del a["event"]
        self.bad(routes(a))
    def test_62_wrong_workflow_path_fails(self):
        self.bad(routes(run_obj(AU, 1, H, TAG, "ci", "workflow_dispatch")))
    def test_63_wrong_repo_fails(self):
        self.bad(routes(run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch", repo={"id": 1, "full_name": "evil/phantom"})))
    def test_64_attempt_mismatch_fails(self):
        self.bad(routes(run_obj(AU, 2, H, TAG, "dependency-audit", "workflow_dispatch")))
    def test_65_audit_run_unreadable_fails(self):
        r = routes(run_obj(AU, 1, H, TAG, "dependency-audit", "workflow_dispatch")); r[REPO + "/actions/runs/%d" % AU] = None
        self.bad(r)

if __name__ == "__main__":
    unittest.main(verbosity=2)
