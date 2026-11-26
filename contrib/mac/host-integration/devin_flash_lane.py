#!/usr/bin/python3
"""DEVIN-FLASH-LANE-1 helper. Pure rules plus a fail-closed models-list re-check.

Free local SWE-2 Flash lane (not Devin cloud; official docs say Flash is not
available in cloud). Maps only swe-2-flash-(medium|high|max) whose official
`devin models list --format json` cost_tier is exactly "Free". Never maps any
*-lightning model, any fusion/sidekick name, or any other *flash* family.

Own cap: lane=devin-flash, separate from PINNED_MAX devin 6. Free cutoff is
2026-12-01T05:00Z (Security). After that instant, every launch is refused.

Eligible jobs: ashlrai/phantom (also "phantom") and hollen689/weyv (also
"weyv"), size S or M, with a clear acceptance section in the prompt. Yield
for this lane is scored on merge rate (caller uses lane_adapt.merge_yield /
yield_holding); thin or unknown yield does not block.

No reading of credential files. No Sessions API. The only subprocess is the
official `devin models list --format json` (or a test-injected runner).
"""
from __future__ import annotations

import json, os, re, subprocess, sys
from datetime import datetime, timezone

CAP_LANE = "devin-flash"
DEFAULT_MODEL = "swe-2-flash-medium"
FLASH_MODEL_RE = re.compile(r"^swe-2-flash-(medium|high|max)$")
END_UTC = datetime(2026, 12, 1, 5, 0, 0, tzinfo=timezone.utc)
END_ISO = "2026-12-01T05:00:00Z"
COST_TIER_FREE = "Free"
ELIGIBLE_SIZES = frozenset(("S", "M"))
ALLOWED_SIZES = frozenset(("S", "M", "L", "XL"))
PINNED_MAX_FLASH = 8
INITIAL_TARGET = 4
DEFAULT_FLOOR = 1
DEFAULT_CEILING = 8
DEVIN_BIN = "/opt/homebrew/bin/devin"
MODELS_LIST_TIMEOUT = 20
_REPO = {
    "phantom": frozenset(("phantom", "ashlrai/phantom")),
    "weyv": frozenset(("weyv", "hollen689/weyv")),
}
_ALIAS = {a: canon for canon, aliases in _REPO.items() for a in aliases}
_ACCEPT = re.compile(
    r"(?im)^(?:#{1,6}\s*)?(?:acceptance(?:\s+criteria)?|done when|"
    r"definition of done|success criteria)\s*:?\s*$"
    r"|acceptance(?:\s+criteria)?\s*:"
)
_SIZE_TOKEN = re.compile(r"(?i)\b(?:size|DEVIN_SIZE)=([SMLX]{1,2})\b")
_BARE_SIZE = re.compile(r"^(?:S|M|L|XL)$")


def _utc(now=None):
    if now is None:
        return datetime.now(timezone.utc)
    if isinstance(now, datetime):
        if now.tzinfo is None:
            return now.replace(tzinfo=timezone.utc)
        return now.astimezone(timezone.utc)
    try:
        return datetime.fromtimestamp(float(now), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


def window_open(now=None):
    """True until the Flash free cutoff 2026-12-01T05:00Z."""
    ts = _utc(now)
    if ts is None:
        return False, "clock-unreadable"
    if ts >= END_UTC:
        return False, "promo-ended"
    return True, "promo-open"


def normalize_repo(repo):
    if not isinstance(repo, str):
        return None
    return _ALIAS.get(repo.strip().lower())


def eligible_repo(repo):
    return normalize_repo(repo) is not None


def is_lightning(name):
    return "lightning" in (name or "").lower()


def is_flash_model(name):
    if not isinstance(name, str):
        return False
    return bool(FLASH_MODEL_RE.fullmatch(name.strip()))


def is_paid_blocked(*names):
    """True when any name is lightning, not an allowlisted flash model, or empty-unknown at call sites that pass a model."""
    for n in names:
        if n is None or n == "":
            continue
        s = str(n)
        if is_lightning(s):
            return True
        # A concrete model string must be swe-2-flash-*; other families are blocked.
        if re.search(r"(?i)(^|[^A-Za-z0-9_-])(swe-2|fusion-|gemini-|glm-|deepseek-)", s) and not is_flash_model(s):
            return True
    return False


def parse_size(fields=None, sidecar_text=None, env=None, line_text=None):
    """Return S, M, L, XL, or None. Fail closed (None) when missing or invalid."""
    def _one(raw):
        if raw is None:
            return None
        s = str(raw).strip().upper()
        if s in ALLOWED_SIZES:
            return s
        m = _SIZE_TOKEN.search(str(raw))
        if m:
            v = m.group(1).upper()
            if v in ALLOWED_SIZES:
                return v
        return None

    sid = (sidecar_text or "").splitlines()
    if sid:
        got = _one(sid[0])
        if got:
            return got
    if env is not None:
        got = _one(env.get("DEVIN_SIZE") if isinstance(env, dict) else None)
        if got:
            return got
    if isinstance(fields, (list, tuple)):
        extra = [str(x).strip() for x in fields[5:] if str(x).strip() and str(x).strip() != "pin"]
        for tok in extra:
            if tok.lower().startswith("devin:"):
                continue
            got = _one(tok)
            if got:
                return got
            if _BARE_SIZE.fullmatch(tok.upper()):
                return tok.upper()
    if line_text:
        got = _one(line_text)
        if got:
            return got
    return None


def has_clear_acceptance(text):
    if not isinstance(text, str) or not text.strip():
        return False
    return bool(_ACCEPT.search(text))


def eligible_job(repo, size=None, prompt_text=None, now=None):
    ok, why = window_open(now)
    if not ok:
        return False, why
    if not eligible_repo(repo):
        return False, "repo-not-eligible"
    sz = size if (isinstance(size, str) and size in ALLOWED_SIZES) else parse_size(line_text=size) if isinstance(size, str) else size
    if sz not in ELIGIBLE_SIZES:
        return False, "size-not-sm"
    if not has_clear_acceptance(prompt_text):
        return False, "no-clear-acceptance"
    return True, "ok"


def want_flash_route(explicit_lane, repo, size, prompt_text, requested_sublane=None, yield_ok=True, flash_free=True, now=None):
    """Launch-time remap / honor decision. Does not rewrite ready.tsv.

    yield_ok: merge-rate holding (True when unknown or thin). flash_free: cap
    headroom on lane=devin-flash. An explicit ACP sub-lane request is never
    stolen. After the promo ends, explicit devin-flash is also refused.
    """
    ok, why = window_open(now)
    if explicit_lane == CAP_LANE:
        if not ok:
            return False, why
        eok, ewhy = eligible_job(repo, size, prompt_text, now=now)
        if not eok:
            return False, ewhy
        if requested_sublane:
            return False, "acp-request"
        if not yield_ok:
            return False, "yield-not-holding"
        if not flash_free:
            return False, "no-capacity"
        return True, "already-flash"
    if not ok:
        return False, why
    if explicit_lane != "devin":
        return False, "not-devin-source"
    if requested_sublane:
        return False, "acp-request"
    eok, ewhy = eligible_job(repo, size, prompt_text, now=now)
    if not eok:
        return False, ewhy
    if not yield_ok:
        return False, "yield-not-holding"
    if not flash_free:
        return False, "no-capacity"
    return True, "route-flash"


def cost_tier_of(payload, model_uid):
    """Return the official cost_tier string, or None if unreadable / missing."""
    if not isinstance(payload, dict) or not isinstance(model_uid, str) or not model_uid:
        return None
    families = payload.get("families")
    if not isinstance(families, list):
        return None
    target = model_uid.strip()
    seen = False
    for fam in families:
        if not isinstance(fam, dict):
            continue
        variants = fam.get("variants")
        if not isinstance(variants, list):
            continue
        for var in variants:
            if not isinstance(var, dict):
                continue
            uid = var.get("model_uid")
            if not isinstance(uid, str) or uid.strip() != target:
                continue
            seen = True
            tier = var.get("cost_tier")
            if isinstance(tier, str) and tier.strip():
                return tier.strip()
            return None
    return None if not seen else None


def resolve_model(models, pool="devin-flash", fam="devin-flash", tier="work"):
    if not isinstance(models, dict):
        return DEFAULT_MODEL
    tier = tier or "work"
    for k in (str(pool) + "." + str(tier), str(pool), str(fam) + "." + str(tier), str(fam)):
        v = models.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return DEFAULT_MODEL


def _run_models_list(runner=None, devin_bin=DEVIN_BIN, timeout=MODELS_LIST_TIMEOUT):
    if runner is not None:
        return runner()
    if not isinstance(devin_bin, str) or not os.path.isabs(devin_bin) or not os.path.isfile(devin_bin):
        return None, "devin-bin-missing"
    try:
        proc = subprocess.run(
            [devin_bin, "models", "list", "--format", "json"],
            capture_output=True, text=True, timeout=timeout,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return None, "models-list-timeout"
    except (OSError, ValueError):
        return None, "models-list-unreadable"
    if proc.returncode != 0:
        return None, "models-list-unreadable"
    try:
        payload = json.loads(proc.stdout or "")
    except (TypeError, ValueError, json.JSONDecodeError):
        return None, "models-list-unreadable"
    if not isinstance(payload, dict):
        return None, "models-list-unreadable"
    return payload, None


def permit_launch(model, payload=None, now=None, list_error=None, runner=None, devin_bin=DEVIN_BIN):
    """Fail-closed pre-launch gate. Anything other than Free, or unreadable, blocks."""
    ok, why = window_open(now)
    if not ok:
        return False, why
    if is_lightning(model):
        return False, "lightning-blocked"
    if not is_flash_model(model):
        return False, "model-not-swe-2-flash"
    err = list_error
    data = payload
    if data is None and err is None:
        data, err = _run_models_list(runner=runner, devin_bin=devin_bin)
    if err or data is None:
        return False, err or "models-list-unreadable"
    tier = cost_tier_of(data, model)
    if tier is None:
        return False, "cost_tier-unreadable"
    if tier != COST_TIER_FREE:
        return False, "cost_tier-not-free"
    return True, "ok"


def cap_lane(sublane=None, default=None):
    return CAP_LANE


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        sys.stderr.write("usage: devin_flash_lane.py check-launch MODEL | window | cap-lane\n")
        return 2
    cmd = argv[0]
    if cmd == "window":
        ok, why = window_open()
        sys.stdout.write(why + "\n")
        return 0 if ok else 5
    if cmd == "cap-lane":
        sys.stdout.write(CAP_LANE + "\n")
        return 0
    if cmd == "check-launch":
        model = argv[1] if len(argv) > 1 else DEFAULT_MODEL
        ok, why = permit_launch(model)
        if ok:
            sys.stdout.write("OK %s %s\n" % (model, why))
            return 0
        sys.stdout.write("REFUSED: %s (%s)\n" % (why, model))
        return 5
    if cmd == "eligible":
        # eligible REPO SIZE -- prompt on stdin
        repo = argv[1] if len(argv) > 1 else ""
        size = argv[2] if len(argv) > 2 else ""
        text = sys.stdin.read() if not sys.stdin.isatty() else ""
        ok, why = eligible_job(repo, size, text)
        sys.stdout.write(why + "\n")
        return 0 if ok else 5
    sys.stderr.write("unknown command\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
