"""Pure lane rules for dispatchd (Core, EO Nov 9 2026). No I/O except what the caller passes in; fixture-tested by test_lane_rules.py.
A. held_zero/held_restore: a held lane's effective target is 0 every tick (no tick or writer can lift it while held); the
   pre-hold target is kept in target_before_hold and restored (capped) when the hold clears, only if the target is still 0.
B. relaunch_recent/relaunch_over: at most RELAUNCH_MAX launch attempts per job id per rolling RELAUNCH_WINDOW seconds.
D. empty_cap: slots.json <lane>.empty_cap = {"max": N, "since": epoch, "reason": ...} caps the lane at N slots until a
   non-empty finish (PUBLISH_START <id> <lane> followed by PUBLISHED <id> <url>) is logged after `since`; then it clears."""
import re, time
RELAUNCH_MAX = 2
RELAUNCH_WINDOW = 6 * 3600

def held_zero(s):
    """Lane is held: force target 0. Returns the previous target if it changed, else None."""
    t = s.get("target", 0)
    if t != 0:
        s.setdefault("target_before_hold", t); s["target"] = 0; return t
    return None

def held_restore(s):
    """Lane is not held: restore target_before_hold once (only if target is still 0). Returns restored value or None."""
    if "target_before_hold" not in s: return None
    tb = s.pop("target_before_hold")
    try: tb = int(tb)
    except (TypeError, ValueError): return None
    if s.get("target", 0) != 0: return None
    nt = max(0, min(tb, s.get("ceiling", tb), s.get("hard_cap", tb))); s["target"] = nt; return nt

def relaunch_recent(text, now, window=RELAUNCH_WINDOW):
    """text: whitespace-separated launch epochs. -> sorted list of epochs inside the window."""
    out = []
    for x in (text or "").split():
        try: v = float(x)
        except ValueError: continue
        if 0 <= now - v < window: out.append(v)
    return sorted(out)

def relaunch_over(text, now, cap=RELAUNCH_MAX, window=RELAUNCH_WINDOW):
    """True when another launch would exceed `cap` attempts in the rolling window."""
    return len(relaunch_recent(text, now, window)) >= cap

_EV_TS = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (PUBLISH_START|PUBLISHED) (\S+)(?: (\S+))?")
def nonempty_finish_since(events_text, lane, since):
    """True if a PUBLISHED <id> <url> follows PUBLISH_START <id> <lane>, both at or after `since` (epoch, local time)."""
    started = set()
    for l in (events_text or "").splitlines():
        m = _EV_TS.match(l)
        if not m: continue
        try: t = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
        except ValueError: continue
        if t < since: continue
        if m.group(2) == "PUBLISH_START" and m.group(4) == lane: started.add(m.group(3))
        elif m.group(2) == "PUBLISHED" and m.group(3) in started and (m.group(4) or "").startswith("https://github.com/"): return True
    return False

def empty_cap(s):
    """-> int cap or None. Bad values fail closed to 0."""
    ec = s.get("empty_cap")
    if not ec: return None
    try: return max(0, int(ec.get("max", 0)))
    except (TypeError, ValueError, AttributeError): return 0


# E. HELD-BACKOFF (Core, EO Nov 9 r3 item 6): launch.sh answering HELD/PAUSED (lane gate, e.g. ultra pace) made dispatchd
#    requeue the line and relaunch it the very next tick (RQ-SWE5-* hit 13-14 attempts that way). dispatchd now stamps
#    queue/run/<id>.heldback on a HELD defer (PAUSED = memguard, still retried next tick) and keeps the line queued (no launch) until HELD_BACKOFF_S has passed.
HELD_BACKOFF_S = 1800
def held_backoff_active(text, now, backoff=HELD_BACKOFF_S):
    try: t = float((text or "").split()[0])
    except (IndexError, ValueError): return False
    return 0 <= now - t < backoff

# F. RELEASE-PIN GUARD (Security standing rule, Nov 9 2026). Verbatim rule:
SECURITY_RELEASE_RULE = ("Mac release scripts (~/.ashlr-runs/bin/release-autorun.sh, bin/release-sign.sh, "
    "release-sign/standing-authority and their LaunchAgents ai.ashlr.release-autorun and similar) change only through "
    "a Security pin. No operator lane installs a repo copy (contrib/mac/*) over the live one.")
PROTECTED_RELEASE_PATHS = (
    "~/.ashlr-runs/bin/release-autorun.sh",
    "~/.ashlr-runs/bin/release-sign.sh",
    "~/.ashlr-runs/release-sign/standing-authority",
    "~/Library/LaunchAgents/ai.ashlr.release-autorun*.plist",
    "~/Library/LaunchAgents/ai.ashlr.release-sign*.plist",
)
_PROT = re.compile(r"release-autorun|release-sign|standing-authority|ai\.ashlr\.release-", re.I)
_VERB = re.compile(r"\b(install(?:s|ed|ing)?|cp|copy|copies|copying|rsync|ditto|mv|move|overwrite|replace|sync|symlink|ln|tee"
                   r"|launchctl\s+(?:load|bootstrap|kickstart|enable))\b", re.I)
_LIVE = re.compile(r"\.ashlr-runs|LaunchAgents|/Users/|\$HOME|~/|contrib/mac|live\b", re.I)
_NEG = re.compile(r"\b(never|do not|don't|must not|mustn't|no operator|not allowed|refuse[sd]?|forbidden|only through a security pin)\b", re.I)
def release_install_refused(prompt_text):
    """Reason string if any sentence of the prompt asks to install/copy/move over a live Mac release path (or install a
    contrib/mac copy of one), else None. A sentence needs a protected name + an install/copy verb + a live-location or
    contrib/mac token, and is ignored when it is a prohibition (never / do not / only through a Security pin)."""
    for sent in re.split(r"(?:\n|(?<=[.;!?])\s+)", prompt_text or ""):
        if _PROT.search(sent) and _VERB.search(sent) and _LIVE.search(sent) and not _NEG.search(sent):
            return "release-pin guard: prompt asks to install/copy over a Security-pinned Mac release path: %s" % sent.strip()[:160]
    return None


# G. ADOPTION HOLD (Security, Nov 9 2026 01:18 ET). No lane may rerun a resource-session adoption from
#    ~/.ashlr-runs/handoff/ until Security's adoption guard is installed. Match execution verbs only;
#    documentation or read-only mentions of these files are allowed.
ADOPTION_HOLD_RULE = ("No lane may rerun a resource-session adoption from ~/.ashlr-runs/handoff/ until "
    "Security's adoption guard is installed. Do not run or invoke adopt_resource_sessions.py, "
    "resource_adoption.py, adoption_launchers.py, adopt_two.py (under handoff/.../private-session-attribution-host-adoption/), or anything under ~/.ashlr-runs/handoff/*/resource-adoption* "
    "or operator/.")
_ADOPT_TARGET = re.compile(
    r"adopt_resource_sessions\.py|resource_adoption\.py|adoption_launchers\.py|adopt_two\.py"
    r"|(?:~|/Users/[^/\s]+|\$HOME)?/\.ashlr-runs/handoff/[^ \t\n]*?/(?:resource-adoption[^ \t\n]*|operator/)"
    r"|(?:^|[^\w.-])handoff/[^ \t\n]*?/(?:resource-adoption[^ \t\n]*|operator/)",
    re.I,
)
_ADOPT_VERB = re.compile(r"\b(python3?|bash|sh|exec|subprocess(?:\.(?:run|Popen|call))?)\b", re.I)
def adoption_hold_refused(prompt_text):
    """Reason string if any sentence asks to run/invoke a resource-session adoption script or handoff
    resource-adoption/operator path via python/bash/sh/exec/subprocess; else None. Prohibitions and
    documentation/read-only mentions are ignored."""
    for sent in re.split(r"(?:\n|(?<=[.;!?])\s+)", prompt_text or ""):
        if _ADOPT_TARGET.search(sent) and _ADOPT_VERB.search(sent) and not _NEG.search(sent):
            return "adoption-hold: prompt asks to run/invoke a handoff resource-adoption path: %s" % sent.strip()[:160]
    return None


# H. RELAUNCH YIELD (Mason design principle 01:48 ET Nov 9, replaces the fixed RELAUNCH_MAX per 6 h in dispatchd): retire an id
#    after YIELD_RETIRE_AFTER consecutive relaunches that produced no RESULT/PR. queue/run/<id>.yield holds one token per finished
#    attempt in order: "1" produced (any RESULT other than EMPTY/ABORT/DENIED), "0" nothing. HELD/PAUSED deferrals never ran and
#    are never recorded (dispatchd drops the pending marker). relaunch_recent/relaunch_over stay for the launch-history record.
YIELD_RETIRE_AFTER = 2
def attempt_produced(result_line):
    r = (result_line or "").strip()
    return bool(r) and r.startswith("RESULT") and not r.startswith(("RESULT EMPTY", "RESULT ABORT", "RESULT DENIED"))
def yield_tokens(text):
    return [t for t in (text or "").split() if t in ("0", "1")]
def yield_retire(text, after=YIELD_RETIRE_AFTER):
    """True when the last `after` attempts were all relaunches (attempt index >= 2) and none produced anything."""
    t = yield_tokens(text)
    return len(t) >= after + 1 and all(x == "0" for x in t[-after:])


# I. DEDUPE KEYS (EO 01:57 ET Nov 9). key = RQ id with a trailing -R<n> retry suffix removed. Target PRs = numbers in the id, plus
#    PR refs in the task head of FIXUP/LAND/SALVAGE/RECUT jobs (their target); context mentions elsewhere never count.
_RSUF = re.compile(r"-R\d+$")
_PRREF = re.compile(r"(?:/pull/|#|\bPR[ -]?)(\d{2,6})\b")
def dedupe_key(job): return (job or "").strip()   # DISPATCHD-DEDUPE-ROOT-1: exact id; -R<n> retries are distinct jobs (06:45 ET Nov 16 -R2 rows were skipped against their own open originals)
def target_prs(job, prompt_text):
    out = set(re.findall(r"(?<![0-9])(\d{3,6})(?![0-9])", re.sub(r"Q\d+$", "", job or ""))) if re.search(r"(?i)FIXUP|LAND|SALVAGE|RECUT|PR", job or "") else set()
    m = re.search(r"(?m)^\S+ \([^)]*\): (.*)$", prompt_text or "")
    head = (m.group(1) if m else "")[:300]
    if re.match(r"\s*(FIXUP|LAND|SALVAGE|RECUT)\b", head) or re.search(r"(?i)FIXUP|LAND|SALVAGE|RECUT", job or ""):
        out |= set(_PRREF.findall(head))
    return sorted(out)
def pr_matches_key(pr, key):
    """Exact normalized match: head branch '<prefix>/<ID>' or title 'bridge: <ID>' (or the bare ID) equals key after -R<n> strip."""
    if not key: return False
    h = str(pr.get("headRefName") or ""); t = str(pr.get("title") or "")
    cand = [h.rsplit("/", 1)[-1]] + [x.group(1) for x in [re.match(r"^\s*(?:bridge:\s*)?([A-Za-z0-9._-]+)\s*$", t)] if x]
    return any(dedupe_key(c).lower() == key.lower() for c in cand)


# J. REMAP GUARDS (Core 02:15 ET Nov 9): a ready.tsv line with an explicit lane is never rewritten; remap is
# launch-time only. A remap target must have free capacity, target > 0, not held, and not over its provider window.
def lane_over_window(lane, res_lane=None, zai_used_5h=None, zai_cap_5h=1940, zai_reserve=250):
    """True when the lane is over its provider window (cannot accept new work). Unknown -> False (not a hold)."""
    if lane == "zai":
        try:
            if zai_used_5h is not None and zai_cap_5h is not None and float(zai_used_5h) + float(zai_reserve) > float(zai_cap_5h):
                return True
        except (TypeError, ValueError): pass
    if isinstance(res_lane, dict):
        try:
            if float(res_lane.get("used_frac", 0)) >= 0.98: return True
        except (TypeError, ValueError): pass
    return False

def remap_target_ok(lane, avail_free, target, held=False, in_hold_file=False, over_window=False):
    """True when `lane` may be chosen as a remap (ROUTE) target."""
    try: free = int(avail_free); tgt = int(target)
    except (TypeError, ValueError): return False
    if held or in_hold_file or over_window: return False
    if tgt <= 0 or free <= 0: return False
    return True

def remap_allowed(explicit_lane, candidate, avail, slots_held, hold_set, over_window_lanes, targets):
    """Pure remap decision. avail: {lane: (free, target)}. -> (ok, reason).
    reason is a short token for REMAP logs: held / over_window / target_0 / no_capacity / ok / same."""
    if not candidate or candidate == explicit_lane: return False, "same"
    if candidate in (hold_set or set()) or (slots_held or {}).get(candidate): return False, "held"
    if candidate in (over_window_lanes or set()): return False, "over_window"
    try: tgt = int((targets or {}).get(candidate, (avail or {}).get(candidate, (0, 0))[1]))
    except (TypeError, ValueError, IndexError): tgt = 0
    try: free = int((avail or {}).get(candidate, (0, 0))[0])
    except (TypeError, ValueError, IndexError): free = 0
    if tgt <= 0: return False, "target_0"
    if free <= 0: return False, "no_capacity"
    if not remap_target_ok(candidate, free, tgt, held=False, in_hold_file=False, over_window=False):
        return False, "no_capacity"
    return True, "ok"

# K. DEVIN-ACP-SUBLANES-1 (staged 2026-11-09): verified Devin sub-lanes share the
# Devin cap (PINNED_MAX 6, lane=devin). Eligible only for ashlrai/phantom and
# hollen689/weyv (short names phantom / weyv also accepted). Paid lightning
# models and Agoragentic are refused. Default Devin (no requested sub-lane)
# is unchanged. The helper bin/devin_acp_sublanes.py owns the allowlists;
# these wrappers stay pure aside from importing that module.
def _devin_acp():
    import devin_acp_sublanes as m
    return m

def devin_acp_eligible(repo, sublane=None):
    """True when repo (and optional requested sub-lane) may use a Devin ACP sub-lane."""
    m = _devin_acp()
    if sublane is None or sublane == "":
        return m.eligible_repo(repo)
    tag, _why = m.resolve(repo, "devin", sublane)
    return tag is not None

def devin_acp_paid_blocked(*names):
    """True when any name is swe-2-*-lightning or Agoragentic."""
    return _devin_acp().is_paid_blocked(*names)

def devin_acp_cap_lane(sublane=None):
    """Caps and holds for a verified sub-lane stay on lane=devin."""
    m = _devin_acp()
    return m.cap_lane(sublane, "devin") if m.parse_sublane(sublane) else "devin"


# L. DEVIN-FLASH-LANE-1 (staged 2026-11-09): free local SWE-2 Flash sub-lane
# with its own cap (not PINNED_MAX devin 6). Eligible only for weyv/phantom
# size S or M with clear acceptance, only swe-2-flash-* with cost_tier Free,
# local only, free cutoff 2026-12-01T05:00Z. The helper bin/devin_flash_lane.py
# owns allowlists and the models-list re-check; these wrappers stay pure
# aside from importing that module. Never maps *-lightning.
def _devin_flash():
    import devin_flash_lane as m
    return m

def devin_flash_eligible(repo, size=None, prompt_text=None, now=None):
    """True when a weyv/phantom S or M job with clear acceptance may use Flash."""
    ok, _why = _devin_flash().eligible_job(repo, size, prompt_text, now=now)
    return ok

def devin_flash_paid_blocked(*names):
    """True when any name is lightning or not an allowlisted swe-2-flash-* model."""
    return _devin_flash().is_paid_blocked(*names)

def devin_flash_cap_lane(sublane=None):
    """Caps and holds for the Flash promo stay on lane=devin-flash, never devin."""
    return _devin_flash().cap_lane(sublane)

def devin_flash_window_open(now=None):
    """True until the Flash free cutoff 2026-12-01T05:00Z; unreadable clock is closed."""
    ok, _why = _devin_flash().window_open(now)
    return ok
