#!/usr/bin/python3
# fleet/sync.py (RQ-SWE5-MACHINERY-AS-CODE): machinery-as-code deploy for ~/.ashlr-runs.
# The manifest (fleet/manifest.json, schema fleet.machinery.v1) declares every machinery
# file, its install root and its class:
#   managed  sync.py installs repo source -> bin with a timestamped backup and a sha256
#            readback. Rollback restores the newest backup.
#   manual   repo source exists; adoption is a separate reviewed ops step. Report-only:
#            sha + drift, never written.
#   pinned   GATES v3 / ops-owned file. Report-only: sha + drift vs the repo mirror when
#            one exists, pin-mismatch vs an optional manifest sha256. Never written.
#   python3 fleet/sync.py [--bin DIR] [--manifest FILE] [--diff] [--json]   (dry run)
#   python3 fleet/sync.py --apply ...                                     (install managed)
#   python3 fleet/sync.py --rollback NAME [--backup FILE]                 (restore newest)
# --bin overrides the runs-bin root (default $ASHLR_RUNS_BIN, then ~/.ashlr-runs/bin);
# the directory must already exist. Unmanaged files in the target are listed under
# "unmanaged" so the ops-side inventory is auditable. Exit 0 ok, 1 a step failed, 2 usage.
# Agents preview with --bin and --json; only Security/operator runs --apply live.
import difflib, hashlib, json, os, shutil, sys, time

SCHEMA = "fleet.machinery.v1"
OUT_SCHEMA = "fleet.sync.v1"
CLASSES = ("managed", "manual", "pinned")
NAME_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
DIFF_LINES = 400


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def repo_root(manifest_path):
    """Repo root = nearest ancestor of the manifest holding .git (worktrees carry a .git file)."""
    d = os.path.dirname(manifest_path)
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return os.path.dirname(manifest_path)
        d = parent


def bad(msg):
    sys.stderr.write("fleet-sync: %s\n" % msg)
    return None


def load_manifest(path):
    try:
        with open(path) as f:
            m = json.load(f)
    except (OSError, ValueError) as e:
        return bad("manifest %s: %s" % (path, e))
    if not isinstance(m, dict) or m.get("schema") != SCHEMA:
        return bad("manifest %s: schema must be %s" % (path, SCHEMA))
    roots, files = m.get("roots"), m.get("files")
    if not isinstance(roots, dict) or not isinstance(files, list):
        return bad("manifest %s: needs roots{} and files[]" % path)
    for name, r in roots.items():
        if not isinstance(r, dict) or not isinstance(r.get("default"), str):
            return bad("root %s: needs a default path" % name)
    seen = set()
    for e in files:
        if not isinstance(e, dict):
            return bad("manifest: file entries must be objects")
        cls, src, name = e.get("class"), e.get("src"), e.get("name")
        if cls not in CLASSES:
            return bad("entry %s: class must be one of %s" % (name or src, ", ".join(CLASSES)))
        if e.get("root") not in roots:
            return bad("entry %s: unknown root %s" % (name or src, e.get("root")))
        if cls == "managed" and not src:
            return bad("managed entry %s: src is required" % name)
        if name is None:
            if not src:
                return bad("entry: src-less entries need a name")
            name = os.path.basename(src)
            e["name"] = name
        if not name or any(c not in NAME_CHARS for c in name) or ".." in name or name.endswith(".lock"):
            return bad("entry: bad name %r" % name)
        if name in seen:
            return bad("entry %s: duplicate name" % name)
        seen.add(name)
        if src is not None and (not isinstance(src, str) or os.path.isabs(src) or ".." in src.split("/")):
            return bad("entry %s: src must be repo-relative without .." % name)
        mode = e.get("mode", "755")
        try:
            e["_mode"] = int(mode, 8)
        except ValueError:
            return bad("entry %s: bad mode %r" % (name, mode))
        if "sha256" in e and (not isinstance(e["sha256"], str) or len(e["sha256"]) != 64):
            return bad("entry %s: sha256 pin must be 64 hex chars" % name)
    return m


def root_path(r, override):
    if override:
        return override
    return os.path.expanduser(os.environ.get(r.get("env") or "", "") or r["default"])


def diff_lines(dst, src, old=None):
    try:
        old = old if old is not None else open(dst, errors="replace").read().splitlines()
        new = open(src, errors="replace").read().splitlines()
    except OSError:
        return
    for i, line in enumerate(difflib.unified_diff(old, new, dst, src, lineterm="")):
        if i >= DIFF_LINES:
            print("... (diff truncated at %d lines)" % DIFF_LINES)
            break
        print(line)


def plan_entry(e, root_dir, src_root, dry):
    """One manifest entry -> status row. Managed new/changed entries get installed under --apply."""
    name, cls = e["name"], e["class"]
    row = {"file": name, "class": cls, "status": None, "src_sha256": None, "dst_sha256": None, "backup": None}
    dst = os.path.join(root_dir, name)
    src = os.path.join(src_root, e["src"]) if e.get("src") else None
    if src and not os.path.isfile(src):
        row["status"] = "error"
        row["reason"] = "source missing: " + e["src"]
        return row
    src_sha = sha(src) if src else None
    row["src_sha256"] = src_sha

    if os.path.islink(dst):
        row["status"] = "error"
        row["reason"] = "refusing symlink destination " + dst
        return row
    exists = os.path.exists(dst)
    if exists and not os.path.isfile(dst):
        row["status"] = "error"
        row["reason"] = "destination is not a regular file"
        return row
    dst_sha = sha(dst) if exists else None
    row["dst_sha256"] = dst_sha

    pin = e.get("sha256")
    if cls == "managed":
        row["status"] = "new" if not exists else ("unchanged" if dst_sha == src_sha else "changed")
        if row["status"] == "changed":
            try:
                row["_old"] = open(dst, errors="replace").read().splitlines()
            except OSError:
                pass
        if not dry and row["status"] in ("new", "changed"):
            tmp = dst + ".tmp.%d" % os.getpid()
            backup = None
            if exists:
                backup = dst + ".bak-fleet-" + STAMP
                try:
                    shutil.copy2(dst, backup)
                except OSError as ex:
                    row["status"], row["reason"], row["backup"] = "error", "backup failed: %s" % ex, backup
                    return row
            try:
                shutil.copyfile(src, tmp)
                os.chmod(tmp, e["_mode"])
                os.replace(tmp, dst)
            except OSError as ex:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                row["status"], row["reason"], row["backup"] = "error", "install failed: %s" % ex, backup
                return row
            if sha(dst) != src_sha:
                row["status"], row["reason"], row["backup"] = "error", "readback sha mismatch", backup
                return row
            row["status"], row["backup"] = "installed", backup
    else:
        if not exists:
            row["status"] = "absent"
        elif src is None:
            row["status"] = "present"
        else:
            row["status"] = "synced" if dst_sha == src_sha else "drift"
        if pin and exists and dst_sha != pin:
            row["status"] = "pin-mismatch"
    return row


def unmanaged(root_dir, known):
    out = []
    try:
        for n in sorted(os.listdir(root_dir)):
            if n in known or n.startswith(".") or ".bak-" in n or ".tmp." in n:
                continue
            if os.path.isfile(os.path.join(root_dir, n)):
                out.append(n)
    except OSError:
        pass
    return out


def rollback(name, root_dir, backup_arg, dry):
    """Restore the newest <name>.bak-* in root_dir; refused for non-managed entries.
    .bak-fleet-pre-* snapshots are audit trail, not candidates: repeated rollbacks
    step back through install backups instead of redoing the rolled-back state."""
    dst = os.path.join(root_dir, name)
    if backup_arg:
        backup = backup_arg
    else:
        cands = sorted(n for n in os.listdir(root_dir)
                       if n.startswith(name + ".bak-") and "-pre-" not in n)
        backup = os.path.join(root_dir, cands[-1]) if cands else None
    row = {"file": name, "action": "rollback", "status": None, "backup": backup, "dst_sha256": None}
    if not backup or not os.path.isfile(backup) or os.path.islink(backup):
        row["status"], row["reason"] = "error", "no usable backup for " + name
        return row
    if os.path.islink(dst) or (os.path.exists(dst) and not os.path.isfile(dst)):
        row["status"], row["reason"] = "error", "destination is a symlink or not a regular file"
        return row
    want = sha(backup)
    row["dst_sha256"] = sha(dst) if os.path.isfile(dst) else None
    row["backup_sha256"] = want
    if dry:
        row["status"] = "would-restore"
        return row
    tmp = dst + ".tmp.%d" % os.getpid()
    if os.path.isfile(dst):
        keep = dst + ".bak-fleet-pre-" + STAMP
        n = 0
        while os.path.exists(keep) or os.path.abspath(keep) == os.path.abspath(backup):
            n += 1
            keep = "%s.%d" % (dst + ".bak-fleet-pre-" + STAMP, n)
        try:
            shutil.copy2(dst, keep)
            row["pre_backup"] = keep
        except OSError as ex:
            row["status"], row["reason"] = "error", "pre-rollback backup failed: %s" % ex
            return row
    try:
        shutil.copyfile(backup, tmp)
        os.chmod(tmp, 0o755)
        os.replace(tmp, dst)
    except OSError as ex:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        row["status"], row["reason"] = "error", "restore failed: %s" % ex
        return row
    row["status"] = "restored" if sha(dst) == want else "error"
    if row["status"] == "error":
        row["reason"] = "readback sha mismatch"
    return row


USAGE = "usage: sync.py [--manifest F] [--bin DIR] [--diff] [--json] [--apply] [--rollback NAME [--backup F]]"
STAMP = time.strftime("%Y%m%d-%H%M%S")


def main(argv):
    manifest, override, i = None, None, 0
    apply_, dry_set, json_, diff, rollback_name, backup_arg = False, False, False, False, None, None
    while i < len(argv):
        a = argv[i]
        if a == "--apply":
            apply_ = True
        elif a == "--dry-run":
            dry_set = True
        elif a == "--json":
            json_ = True
        elif a == "--diff":
            diff = True
        elif a in ("--manifest", "--bin", "--rollback", "--backup") and i + 1 < len(argv):
            v = argv[i + 1]
            if a == "--manifest":
                manifest = v
            elif a == "--bin":
                override = v
            elif a == "--rollback":
                rollback_name = v
            else:
                backup_arg = v
            i += 1
        elif a in ("-h", "--help"):
            with open(__file__) as f:
                head = []
                for line in f:
                    if not line.startswith("#") or line.startswith("#!"):
                        if line.startswith("#"):
                            continue
                        break
                    head.append(line.lstrip("# "))
                print("".join(head).strip())
            return 0
        else:
            sys.stderr.write(USAGE + "\n")
            return 2
        i += 1
    if apply_ and dry_set:
        sys.stderr.write("fleet-sync: --apply and --dry-run conflict\n")
        return 2
    dry = not apply_
    manifest = manifest or os.path.join(os.path.dirname(os.path.abspath(__file__)), "manifest.json")
    m = load_manifest(manifest)
    if m is None:
        return 2
    src_root = repo_root(os.path.abspath(manifest))
    r = m["roots"].get("runs-bin")
    if r is None:
        sys.stderr.write("fleet-sync: manifest has no runs-bin root\n")
        return 2
    if backup_arg is not None and rollback_name is None:
        sys.stderr.write("fleet-sync: --backup only applies with --rollback\n")
        return 2
    root_dir = root_path(r, override)
    if not os.path.isdir(root_dir):
        sys.stderr.write("fleet-sync: %s is not a directory\n" % root_dir)
        return 1
    by_name = {e["name"]: e for e in m["files"]}

    if rollback_name is not None:
        e = by_name.get(rollback_name)
        if e is None:
            sys.stderr.write("fleet-sync: %s is not in the manifest\n" % rollback_name)
            return 2
        if e["class"] != "managed":
            sys.stderr.write("fleet-sync: %s is class %s; rollback covers managed files only\n" % (rollback_name, e["class"]))
            return 2
        row = rollback(rollback_name, root_dir, backup_arg, dry)
        if not json_:
            extra = " (backup %s)" % row["backup"] if row.get("backup") else ""
            print("%s: %s%s" % (row["file"], row["status"], extra))
            if row.get("reason"):
                print("  reason: " + row["reason"])
        if json_:
            print(json.dumps({"schema": OUT_SCHEMA, "bin": root_dir, "dry_run": dry,
                              "ok": row["status"] in ("restored", "would-restore"), "files": [row]}, indent=2))
        return 0 if row["status"] in ("restored", "would-restore") else 1

    pairs = [(e, plan_entry(e, root_dir, src_root, dry)) for e in m["files"] if e["root"] == "runs-bin"]
    files = [row for _e, row in pairs]
    if diff:
        for e, row in pairs:
            if row["class"] == "managed" and row["status"] in ("changed", "installed") and row.get("_old"):
                diff_lines(os.path.join(root_dir, e["name"]), os.path.join(src_root, e["src"]), row["_old"])
    rc = 1 if any(f["status"] == "error" for f in files) else 0
    um = unmanaged(root_dir, by_name)
    if not json_:
        for f in files:
            extra = " (backup %s)" % f["backup"] if f.get("backup") else ""
            print("%s: %s%s sha256=%s" % (f["file"], f["status"], extra, f["src_sha256"] or "-"))
            if f.get("reason"):
                print("  reason: " + f["reason"])
        if um:
            print("unmanaged in %s: %s" % (root_dir, " ".join(um)))
    if json_:
        pub = [{k: v for k, v in f.items() if not k.startswith("_")} for f in files]
        print(json.dumps({"schema": OUT_SCHEMA, "manifest": manifest, "bin": root_dir, "dry_run": dry,
                          "ok": rc == 0, "files": pub, "unmanaged": um}, indent=2))
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
