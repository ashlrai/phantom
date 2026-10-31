#!/usr/bin/python3
# restock.py — Mac-side deterministic restocker for the router queue (no LLM, no network of its own).
# Installed to ~/.ashlr-runs/bin/restock.py via swap.sh and sha-pinned by selfrun.sh (G1-CODE-PIN); run as
# `restock.py [--dry-run] [--per-lane N]`. RQ-QUEUEGEN-BOLD-30 + SPEC-AMEND Security #5 + RQ-DEVINROUTEDEFAULTQ7 rev.
import os, re, sys, json, time, fcntl, subprocess
H = os.path.expanduser("~"); R = H + "/.ashlr-runs"; Q = R + "/queue"; EV = R + "/dispatch-events.log"
DRY = "--dry-run" in sys.argv
PER = int(sys.argv[sys.argv.index("--per-lane") + 1]) if "--per-lane" in sys.argv else None
TS = time.strftime("%F %T"); HM = time.strftime("%H:%M")
CODEX = ["codex-cmp", "codex-personal", "devin", "codex-local"]  # restockable lanes (devin unheld 2:25 PM per Mason; codex-local RQ-LOCAL-LANE)
CODEX.append("claude-api")  # paced by claude-api.py via slots.json target (0 when no credit pool is open)
GENERAL = [l for l in CODEX if l != "codex-local"]  # rev1.1: local models are not a general fallback; only pool=codex-local goes there
# RQ-QUEUEGEN-BOLD-30 (SPEC-AMEND Security #5): GS_REPOS is the fleet allowlist — the core-fleet spine that is
# checked out under ~/Projects/ashlrai (docs/ECOSYSTEM-MAP.md). measurably and ashlar-landing live there too but
# are not fleet: a directory existing is never enough to make a line selectable, and restock never creates for them.
GS_REPOS = {"phantom", "phantom-secrets", "locus", "lexicon", "ashlr-md", "ashlr-plugin", "ashlr-stack"}
BOLD_MIN = 0.30   # keep READY at >=30% bet=bold lines: counted before each restock; under the floor bold picks first
PIN = "[Security pin required]"
# Lines touching these surfaces are security-pinned (SPEC-AMEND Security #5): they enter as HOLD-SECURITY carrying
# PIN, and bold preference never promotes them back to READY. Negated mentions ("never touch .github") are
# stripped before matching so a prose prohibition does not park the line.
SEC = re.compile(r"(?i)\.github/?\*{0,2}|\bpublish\.sh\b|\bdispatchd\b|\bgit[-_]safe\b|\bscrub(?:bed|bing|s)?\b|\breap(?:ed|ing|ers?|s)?\b")
NEGS = re.compile(r"(?i)\b(?:no|not|never|do not touch|without|avoid(?:ing)?|outside)\b[^.;,]{0,25}(?:\.github/?\*{0,2}|publish\.sh|dispatchd|git[-_]safe|scrub(?:bed|bing|s)?|reap(?:ed|ing|ers?|s)?)")
ISBOLD = re.compile(r"\bbet=bold\b", re.I)
# RQ-DEVINROUTEDEFAULTQ7 (DEVIN-LEVERAGE-20261026): a line that leaves its pool open (no pool= attr or
# pool=any) and is tier=frontier or marked long-horizon defaults to pool=devin; queuegen stamps new
# frontier/long-horizon lines pool=devin the same way. Devin's leverage target is 10 and its ceiling
# 16: need["devin"] reads slots.json target (default 10) clamped at the ceiling, so a held or full
# devin lane falls back to the neediest GENERAL lane and never overbooks.
DEVIN_T = 10; DEVIN_C = 16
DVLH = re.compile(r"(?i)\b(?:horizon=long(?:-horizon)?|long[-_]horizon)\b")
def devin_default(tm, attrs):   # open pool + frontier tier or a long-horizon marker -> devin by default
    return bool(tm and tm.group(1) == "frontier") or bool(DVLH.search(attrs))
def rd(p, d=""):
    try: return open(p).read()
    except Exception: return d
st = json.loads(rd(Q + "/status.json", "{}") or "{}"); lanes = st.get("lanes", {})
slots = json.loads(rd(Q + "/slots.json", "{}") or "{}")
hold = set(rd(R + "/HOLD").split())
need = {}
for l in CODEX:
    s = lanes.get(l, {}); t = slots.get(l, {}).get("target", DEVIN_T if l == "devin" else 10)
    if l == "devin" and isinstance(t, int): t = min(t, DEVIN_C)   # leverage ceiling 16 caps restock need
    if slots.get(l, {}).get("held") or l in hold: need[l] = 0; continue
    if l == "claude-api" and not slots.get(l, {}).get("target"): need[l] = 0; continue   # paced to 0: no credit pool open
    free = max(t - s.get("running", 0), 0)
    want = PER if PER is not None else 3 * max(free, 4)
    need[l] = max(want - s.get("queued", 0), 0)
lines = rd(Q + "/router-queue.md").splitlines()
if not lines: print("no router-queue.md copy"); sys.exit(0)
status = {}; recs = []; held_pr = set()
for i, l in enumerate(lines):
    m = re.match(r"^- ([A-Z][A-Z-]*)\b", l)
    if not m: continue
    m2 = re.match(r"^- READY ([A-Za-z0-9][A-Za-z0-9._-]+)(?: r\d+)? \((.*?)\):\s*(.*)$", l)
    ids = re.findall(r"\b((?:RQ|RADAR|LAND|G\d|FIX)[A-Za-z0-9._-]*[A-Za-z0-9])\b", l[:200])
    for j in ids[:1]: status.setdefault(j, m.group(1))
    for j in re.findall(r"\b(?:CLAIMED|DONE|PR-OPEN)[^A-Z]{0,40}?([A-Z][A-Z0-9-]*-[A-Za-z0-9._-]+)", l[:160])[:1]: status[j] = l.split()[1]
    if m.group(1) in ("HOLD", "HOLD-SECURITY"):   # hold-list PRs (amendment #5): (repo|*, pr#) pairs never selectable
        hr = re.search(r"\brepo=(?:ashlrai/)?([a-z0-9-]+)", l)
        for n in re.findall(r"(?:pull/|PR=|#)(\d+)", l): held_pr.add((hr.group(1) if hr else "*", n))
        for rr, n in re.findall(r"github\.com/[A-Za-z0-9._-]+/([A-Za-z0-9._-]+)/pull/(\d+)", l): held_pr.add((rr, n))
    if m2: recs.append((i, m2.group(1), m2.group(2), m2.group(3), l))
claimed = {x.split("\t")[0] for x in rd(Q + "/claimed.tsv").splitlines() if x}
inq = {x.split("\t")[0] for x in rd(Q + "/ready.tsv").splitlines() if x}
merged = set()
for x in rd(R + "/metrics/jobs.jsonl").splitlines():
    try: d = json.loads(x)
    except Exception: continue
    if d.get("event") == "outcome" and d.get("state") == "MERGED": merged.add(d.get("job"))
try: ps = subprocess.run(["ps", "-axo", "command="], capture_output=True, text=True).stdout
except Exception: ps = ""   # sandboxed callers may refuse ps; the worktree-dir check in busy() still applies
def landed(dep): return dep in merged or status.get(dep, "") in ("DONE", "MERGED", "LANDED")
def busy(j):
    if j in claimed or j in inq or os.path.exists(Q + "/run/" + j + ".reaping"): return "claimed/queued"
    if os.path.isdir(H + "/Projects/ashlrai/wt/" + j) or ("/wt/" + j + " ") in ps or ("/wt/" + j + "\n") in ps: return "alive/worktree"
    if "RESULT PR" in rd("%s/%s.publish" % (R, j)): return "published"
    return None
def prio(a): m = re.search(r"\bP(\d)\b", a); return int(m.group(1)) if m else 3
skips = {}; picks = {l: [] for l in CODEX}
def skip(j, why): skips[why] = skips.get(why, 0) + 1
# bold census before the restock (RQ-QUEUEGEN-BOLD-30): the READY stock's share of bet=bold decides prefer_bold
ready_n = len(recs); ready_bold = sum(1 for r in recs if ISBOLD.search(r[2]))
bold_frac = ready_bold / ready_n if ready_n else 0.0   # empty READY stock reads as starved, not satisfied
prefer_bold = bold_frac < BOLD_MIN
# security pre-pass: park every READY line touching a pinned surface as HOLD-SECURITY, before any pick and
# regardless of lane need, so a sensitive line can never ride in on the bold preference or any other path
seclist = []
for i, j, a2, t2, raw2 in recs:
    if SEC.search(NEGS.sub("", raw2)): seclist.append((i, j)); skip(j, "hold-security")
parked = {i for i, j in seclist}
# under the bold floor bold lines pick first, then P-level, then line order; at/above it the order is unchanged
ordk = (lambda r: (not ISBOLD.search(r[2]), prio(r[2]), r[0])) if prefer_bold else (lambda r: (prio(r[2]), r[0]))
for i, j, attrs, text, raw in sorted(recs, key=ordk):
    if all(len(picks[l]) >= need[l] for l in CODEX): break
    if i in parked: continue
    if re.search(r"(?i)not bridge|owner-authored|\bowners?\b|RETIRED|folds into|reuse the kept worktree|repos=|standing|tier=local", attrs + " " + text[:200]): skip(j, "not-bridge/fold/kept-reuse"); continue
    if not re.match(r"^[A-Z]", j): skip(j, "bad-id"); continue
    if re.search(r"sub of " + re.escape(j) + r"\b", rd(Q + "/router-queue.md")): skip(j, "split-into-subs"); continue
    if "BASE_OVERRIDE" in attrs: skip(j, "base-override(supervisor)"); continue
    rm = re.search(r"\brepo=(?:ashlrai/)?([a-z0-9-]+)", attrs)
    if not rm:
        lm = re.match(r"^LAND-(?:RECUT-)?([a-z][a-z-]*?)-\d+$", j)
        if lm: rm = lm
    if not rm:
        for tok in [t.strip() for t in attrs.split(",")]:
            if tok in GS_REPOS: rm = re.match(r"(.*)", tok); break
    pm = re.search(r"pool=([a-z-]+)", attrs); tm = re.search(r"tier=([a-z]+)", attrs)
    if rm and rm.group(1) not in GS_REPOS: skip(j, "non-fleet-repo"); continue
    if not rm or not os.path.isdir(H + "/Projects/ashlrai/" + rm.group(1)): skip(j, "no-repo"); continue
    pool = pm.group(1) if pm and pm.group(1) != "any" else "any"
    if pool == "any" and devin_default(tm, attrs): pool = "devin"   # frontier/long-horizon -> devin by default
    if pool == "any": pool = max(GENERAL, key=lambda l: (need[l] - len(picks[l]), l == "devin"))
    if pool not in CODEX: skip(j, "lane-" + pool); continue
    prp = set(re.findall(r"github\.com/[A-Za-z0-9._-]+/([A-Za-z0-9._-]+)/pull/(\d+)", raw))
    prp |= {(rm.group(1), n) for n in re.findall(r"(?:pull/|PR=|#)(\d+)", attrs + " " + text)}
    if prp & held_pr or any(("*", n) in held_pr for _, n in prp): skip(j, "hold-list-pr"); continue
    deps = []
    for a in re.findall(r"after ([^,]+)", attrs):
        for d in re.split(r"\s+and\s+|,\s*", a.strip()):
            d = d.strip()
            if d.lower() in ("", "none", "-", "n/a"): continue
            if re.match(r"^-[A-Z]$", d):
                mm = re.match(r"^(.*)-[A-Z]$", j)
                d = (mm.group(1) + d) if mm else None
                if d is None or d == j: deps.append(None); continue
            deps.append(d)
    if None in deps: skip(j, "bad-dep"); continue
    if any(not re.match(r"^[A-Za-z0-9._-]+$", d) or not landed(d) for d in deps): skip(j, "after-unlanded"); continue
    b = busy(j)
    if b: skip(j, b); continue
    if any(j == x[0] for l2 in CODEX for x in picks[l2]): skip(j, "dup-line"); continue
    tier = tm.group(1) if tm and tm.group(1) in ("frontier", "work", "mid", "fast") else "work"
    # balance codex lanes: line pool first, else the lane with more unmet need (cmp wins ties)
    lane = pool if len(picks[pool]) < need[pool] or pool == "codex-local" else max(GENERAL, key=lambda l: (need[l] - len(picks[l]), l == "devin"))
    if len(picks[lane]) >= need[lane]: continue
    picks[lane].append((j, rm.group(1), lane, tier, attrs, text, i))
out = []; ts = int(time.time())
for lane in CODEX:
    for j, repo, l, tier, attrs, text, i in picks[lane]:
        p = (f"Job {j} (pool {l}, tier {tier}, repo {repo}). Task from the Ashlr router queue, verbatim:\n\n{j} ({attrs}): {text}\n\n"
             "Treat the task as the minimum: be ambitious and high-leverage, and finish one complete, self-contained, mergeable change "
             "that meets every acceptance item above, with new or updated tests that you run. Never print environment variables, secrets or tokens; "
             "solve any secrets need through Phantom Secrets and any MCP/CLI access need through Locus. Do not commit or push, and do not edit .github/.\n")
        pf = f"{Q}/prompts/{j}.md"
        out.append((j, repo, l, tier, pf, p, i))
pk_n = sum(len(picks[l]) for l in CODEX); pk_b = sum(1 for l in CODEX for x in picks[l] if ISBOLD.search(x[4]))
print("need", json.dumps(need), "picked", {l: len(picks[l]) for l in CODEX},
      "bold ready=%d/%d(%.2f) picked=%d/%d(%.2f)%s" % (ready_bold, ready_n, bold_frac, pk_b, pk_n, pk_b / pk_n if pk_n else 0.0, " prefer=bold" if prefer_bold else ""),
      "skips", json.dumps(skips))
for i, j in seclist: print(("DRY " if DRY else "") + "HOLD-SECURITY\t" + j)
for j, repo, l, tier, pf, p, i in out: print(("DRY " if DRY else "") + "\t".join([j, repo, l, tier]))
if DRY or (not out and not seclist): sys.exit(0)
for j, repo, l, tier, pf, p, i in out: open(pf, "w").write(p)
with open(Q + "/ready.lock", "a") as lk:
    fcntl.flock(lk, fcntl.LOCK_EX)
    with open(Q + "/ready.tsv", "a") as f:
        for j, repo, l, tier, pf, p, i in out: f.write("\t".join([j, repo, l, tier, pf]) + "\n")
with open(Q + "/claimed.tsv", "a") as f:
    for j, repo, l, tier, pf, p, i in out: f.write("\t".join([j, l, tier, HM, str(ts)]) + "\n")
for j, repo, l, tier, pf, p, i in out:   # mark local copy so the next restock never re-picks
    lines[i] = re.sub(r"^- READY ", "- CLAIMED %s dispatchd %s " % (HM, l), lines[i], count=1)
for i, j in seclist:   # park security-pinned lines; the tag stays on the line and READY is never restored
    lines[i] = re.sub(r"^- READY ", "- HOLD-SECURITY %s restock " % HM, lines[i], count=1)
    if PIN not in lines[i]: lines[i] = lines[i].rstrip() + " " + PIN
open(Q + "/router-queue.md.tmp", "w").write("\n".join(lines) + "\n"); os.replace(Q + "/router-queue.md.tmp", Q + "/router-queue.md")
with open(EV, "a") as f: f.write("%s RESTOCK queued %d (%s) bold=%.2f sec=%d\n" % (TS, len(out), ", ".join("%s=%d" % (l, len(picks[l])) for l in CODEX), bold_frac, len(seclist)))
