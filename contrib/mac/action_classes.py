#!/usr/bin/python3
"""action_classes.py (RQ-SWE5-ACTION-CLASSES): reader for the unified action-class
autonomy registry. The canonical data lives in src/core/authority/action-classes.ts;
action-classes.json is the installed projection that dispatchd.py and publish.sh
consume (a vitest case keeps it equal to the TS projection).

Fail closed everywhere: a missing, unreadable or malformed registry loads as
None, and resolve() returns the `unlisted` descriptor (gate=forbidden) for any
name the registry does not list.

CLI (for publish.sh and humans; reads --registry PATH, ACTION_CLASSES_JSON, or
the sibling action-classes.json next to this script):

  action_classes.py list [--json]
  action_classes.py resolve <name> [--json]
  action_classes.py classify <job-id> [--json]
  action_classes.py check <name>   # exit 0 iff listed and publishable; prints gate=<gate>
"""
import json, os, sys

SCHEMA = "action-classes.v1"
GATES = ("open", "confined-launch", "publish-pipeline", "merge-queue",
         "release-channel", "channel-approval", "operator", "forbidden")
BLAST_RADII = ("none", "worktree", "host", "fork", "upstream", "public", "credentials", "unknown")
REVERSIBILITIES = ("free", "revertible", "costly", "irreversible")
DEFAULT_PUBLISHABLE = ("publish-pipeline", "merge-queue")

UNLISTED = {"listed": False, "gate": "forbidden", "blastRadius": "unknown",
            "reversibility": "irreversible", "summary": "unlisted action class — fail closed"}

def default_registry_path():
    return os.environ.get("ACTION_CLASSES_JSON") or os.path.join(
        os.path.dirname(os.path.realpath(__file__)), "action-classes.json")

def load(path=None):
    """Parse and shape-check the registry; None on any error (fail closed)."""
    path = path or default_registry_path()
    try:
        with open(path) as f:
            reg = json.load(f)
    except Exception:
        return None
    if not isinstance(reg, dict) or reg.get("schema") != SCHEMA:
        return None
    classes = reg.get("classes")
    if not isinstance(classes, dict) or not classes:
        return None
    for name, entry in classes.items():
        if not isinstance(name, str) or not isinstance(entry, dict):
            return None
        if (entry.get("gate") not in GATES or entry.get("blastRadius") not in BLAST_RADII
                or entry.get("reversibility") not in REVERSIBILITIES
                or not isinstance(entry.get("summary"), str)):
            return None
    jcm = reg.get("jobClassMap")
    prefixes = jcm.get("prefixes") if isinstance(jcm, dict) else None
    if not isinstance(prefixes, list) or jcm.get("default") not in classes:
        return None
    for pair in prefixes:
        if (not isinstance(pair, list) or len(pair) != 2 or not isinstance(pair[0], str)
                or pair[1] not in classes):
            return None
    pg = reg.get("publishableGates")
    if not isinstance(pg, list) or not pg or any(g not in GATES for g in pg):
        return None
    return reg

def resolve(reg, name):
    """Registry entry plus `listed`/`name`; the unlisted descriptor otherwise."""
    if isinstance(reg, dict) and isinstance(reg.get("classes"), dict):
        entry = reg["classes"].get(name)
        if isinstance(entry, dict):
            return dict(entry, listed=True, name=name)
    return dict(UNLISTED, name=name)

def disposition(reg, name):
    """'allowed' | 'operator' | 'forbidden' — the last also covers unlisted names."""
    gate = resolve(reg, name)["gate"]
    return "forbidden" if gate == "forbidden" else "operator" if gate == "operator" else "allowed"

def may_run(reg, name):
    return disposition(reg, name) == "allowed"

def classify_job(reg, job):
    """Publish-phase class for a dispatched job id; 'unlisted' when unresolvable."""
    if not isinstance(reg, dict):
        return "unlisted"
    jcm = reg.get("jobClassMap") or {}
    for pair in jcm.get("prefixes") or []:
        if job.startswith(pair[0]):
            return pair[1]
    default = jcm.get("default")
    return default if isinstance(default, str) else "unlisted"

def may_publish(reg, name):
    """The generic dispatcher publish path may run only publishable-gate classes."""
    entry = resolve(reg, name)
    if entry["listed"] is not True:
        return False
    pg = reg.get("publishableGates")
    gates = pg if isinstance(pg, list) and pg else list(DEFAULT_PUBLISHABLE)
    return entry["gate"] in gates

def _emit(obj, as_json):
    print(json.dumps(obj, sort_keys=True) if as_json else obj)

def main(argv):
    reg_path = None
    args = list(argv)
    for i, a in enumerate(args):
        if a == "--registry" and i + 1 < len(args):
            reg_path = args[i + 1]
            del args[i:i + 2]
            break
    as_json = "--json" in args
    if as_json:
        args.remove("--json")
    reg = load(reg_path)
    cmd = args[0] if args else "list"
    if reg is None:
        if cmd == "check":
            print("registry-unavailable", file=sys.stderr)
            return 4
        _emit({"schema": SCHEMA, "loaded": False}, as_json)
        return 1
    if cmd == "list":
        _emit(reg if as_json else "\n".join(sorted(reg["classes"])), True if as_json else False)
        return 0
    if cmd == "resolve" and len(args) == 2:
        _emit(resolve(reg, args[1]), as_json)
        return 0 if resolve(reg, args[1])["listed"] else 2
    if cmd == "classify" and len(args) == 2:
        cls = classify_job(reg, args[1])
        _emit({"job": args[1], "class": cls, "entry": resolve(reg, cls)}, as_json)
        return 0
    if cmd == "check" and len(args) == 2:
        entry = resolve(reg, args[1])
        if entry["listed"] is not True:
            print("unlisted", file=sys.stderr)
            return 3
        if not may_publish(reg, args[1]):
            print("gate=%s" % entry["gate"], file=sys.stderr)
            return 2
        print("gate=%s" % entry["gate"])
        return 0
    print(__doc__.strip(), file=sys.stderr)
    return 2

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
