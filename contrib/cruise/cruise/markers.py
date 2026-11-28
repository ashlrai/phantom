"""Spotlight / FSEvents exclusion markers for fleet worktrees (no sudo, no system settings).

What the platform actually honours (researched Nov 24 2026; see README "Indexing and FSEvents"):
  * FSEvents has no per-directory exclusion. `.fseventsd/no_log` works only at a VOLUME root.
    The sanctioned per-user route is a separate volume for worktrees (an APFS sparse image
    attached with hdiutil, no sudo) carrying `.fseventsd/no_log` and `.metadata_never_index`.
  * Spotlight: `.metadata_never_index` inside a folder is no longer honoured on recent macOS;
    a folder named `*.noindex` or a dot-prefixed folder is. We still drop the marker (harmless,
    honoured on older releases and at volume roots) and report the `.noindex` move as the fix.
Writes are restricted to places git already ignores, so worktrees stay clean for clean-tree gates:
the worktree container itself (not a git tree), and node_modules / build dirs that the
worktree's own .gitignore lists. No git subprocess, no recursive walk (one scandir per level)."""
from __future__ import annotations

import os

MARKER = ".metadata_never_index"
BUILD_DIRS = ("node_modules", "dist", "build", "out", ".next", "target", "coverage", ".turbo")
NESTED_PARENTS = ("packages", "apps")


def _ignored_names(wt):
    names = set()
    try:
        with open(os.path.join(wt, ".gitignore")) as f:
            for line in f:
                l = line.strip()
                if not l or l.startswith("#") or l.startswith("!"): continue
                names.add(l.strip("/").lstrip("*").strip("/"))
    except OSError:
        pass
    return names


def plan(container, max_worktrees=None):
    """[(path, why)] markers to create. container: dir holding worktrees (e.g. ~/Projects/ashlrai/wt)."""
    out = []
    if not os.path.isdir(container) or os.path.exists(os.path.join(container, ".git")): return out
    if not os.path.exists(os.path.join(container, MARKER)): out.append((os.path.join(container, MARKER), "container"))
    try: wts = sorted(e.path for e in os.scandir(container) if e.is_dir(follow_symlinks=False))
    except OSError: return out
    for wt in wts[:max_worktrees] if max_worktrees else wts:
        ign = _ignored_names(wt)
        dirs = [wt] + [os.path.join(wt, p, c) for p in NESTED_PARENTS if os.path.isdir(os.path.join(wt, p))
                       for c in _ls(os.path.join(wt, p))]
        for d in dirs:
            for b in BUILD_DIRS:
                bd = os.path.join(d, b)
                if b in ign and os.path.isdir(bd) and not os.path.islink(bd) and not os.path.exists(os.path.join(bd, MARKER)):
                    out.append((os.path.join(bd, MARKER), "ignored_build_dir"))
    return out


def _ls(d):
    try: return [e.name for e in os.scandir(d) if e.is_dir(follow_symlinks=False)]
    except OSError: return []


def apply(items):
    n = 0
    for path, _why in items:
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644); os.close(fd); n += 1
        except FileExistsError:
            pass
        except OSError:
            continue
    return n
