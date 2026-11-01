#!/usr/bin/env python3
"""Bounded assistant for Safari's "File > Import From > Google Chrome" flow.

Drives only Safari's own import UI through System Events via fixed
AppleScript strings and argv-bound menu labels. Inspects menu labels and
dialog existence only — never field values, page content, cookies, login
records, Keychain items or profile stores — and never exports passwords or
sessions. Authentication and Keychain/Touch ID prompts stay with macOS and
the human operator. An open dialog never means an import finished or that
any website is signed in.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

TOOL, POLL = "safari-import", 0.4
SAFARI_APP = "/Applications/Safari.app"
CHROME_APPS = ("/Applications/Google Chrome.app",
               str(Path.home() / "Applications/Google Chrome.app"))
OSA, OPEN = "/usr/bin/osascript", "/usr/bin/open"

SCRIPT_RUNNING = 'tell application "System Events" to exists process "Safari"'
SCRIPT_LABELS = """tell application "System Events" to tell process "Safari"
  if not (exists menu item "Import From" of menu "File" of menu bar 1) then return "MISSING-IMPORT-FROM"
  set out to ""
  repeat with it in (menu items of menu 1 of menu item "Import From" of menu "File" of menu bar 1)
    try
      set out to out & name of it & linefeed
    end try
  end repeat
  return out
end tell"""
SCRIPT_SHEET = """tell application "System Events" to tell process "Safari"
  repeat with w in windows
    if exists sheet 1 of w then
      try
        if (name of sheet 1 of w) contains "Import" or (name of sheet 1 of w) contains "Chrome" then return "import"
      end try
      return "other"
    end if
  end repeat
  return "none"
end tell"""
SCRIPT_KEYCHAIN = """tell application "System Events"
  if not (exists process "SecurityAgent") then return "none"
  tell process "SecurityAgent" to return (exists window 1)
end tell"""
SCRIPT_CLICK = """on run argv
  set wanted to item 1 of argv
  tell application "System Events" to tell process "Safari"
    click (first menu item of menu 1 of menu item "Import From" of menu "File" of menu bar 1 whose name is wanted)
  end tell
end run"""

ACTIONS = {
    "accessibility": "grant the caller Accessibility in System Settings > Privacy & Security > Accessibility",
    "automation-consent": "approve the macOS automation prompt shown for the caller",
    "keychain-prompt": "answer the pending macOS Keychain/Touch ID prompt; secrets stay with the OS",
    "confirmation-prompt": "answer or dismiss the active Safari sheet, then rerun",
    "import-menu-missing": "Safari shows no File > Import From menu (old Safari or localized UI)",
    "chrome-import-missing": "Safari's Import From menu has no Google Chrome entry; confirm Chrome exists",
    "chrome-not-installed": "Google Chrome.app not found under /Applications or ~/Applications",
    "dialog-not-opened": "no import sheet appeared after clicking the menu item",
    "system-events": "System Events probe failed",
    "launch-failed": "open -a Safari failed or Safari never appeared",
}
NEXT_DONE = ("human: in Safari's import sheet choose items and click Import; "
             "approve any Keychain/Touch ID prompt yourself. Second Mac: turn on "
             "iCloud Keychain sync in System Settings > Apple Account > iCloud > "
             "Passwords & Keychain. This tool changed no account settings.")
NEXT_STATUS = ("run `python3 scripts/mac-bridge/safari_import.py begin-import` "
               "to open the dialog; afterwards sync passwords to a second Mac "
               "via iCloud Keychain (see --help).")
EPILOG = """machine-readable output: JSON result on stdout, JSONL progress on stderr.
next action (second Mac): after the human finishes the import here, enable
iCloud Keychain sync on the other Mac (System Settings > Apple Account >
iCloud > Passwords & Keychain > Sync this Mac). This tool never toggles
account settings, never provisions machines, and never touches secrets."""

class ProbeError(Exception):
    def __init__(self, reason, detail=""):
        super().__init__(reason)
        self.reason, self.detail = reason, detail

def classify_error(stderr):
    s = (stderr or "").lower()
    if "assistive" in s or "accessibility" in s or "-25211" in s:
        return "accessibility"
    if "-1743" in s or "not permitted" in s or "automation" in s:
        return "automation-consent"
    return "system-events"

class SystemEvents:
    """Real UI adapter: fixed scripts, argv-bound labels, categories only."""

    def _osa(self, script, *argv):
        try:
            p = subprocess.run([OSA, "-e", script, *argv],
                               capture_output=True, text=True, timeout=15)
        except (OSError, subprocess.SubprocessError) as e:
            raise ProbeError("system-events", str(e)[:200])
        if p.returncode != 0:
            raise ProbeError(classify_error(p.stderr), p.stderr.strip()[:200])
        return p.stdout.strip()

    def platform_supported(self):
        return sys.platform == "darwin"

    def safari_installed(self):
        return Path(SAFARI_APP).is_dir()

    def chrome_installed(self):
        return any(Path(p).is_dir() for p in CHROME_APPS)

    def safari_running(self):
        return self._osa(SCRIPT_RUNNING) == "true"

    def import_dialog(self):
        return self._osa(SCRIPT_SHEET)

    def keychain_prompt(self):
        return self._osa(SCRIPT_KEYCHAIN) == "true"

    def click_import_item(self, label):
        self._osa(SCRIPT_CLICK, label)

    def import_menu_labels(self):
        out = self._osa(SCRIPT_LABELS)
        return None if out == "MISSING-IMPORT-FROM" else \
            [l.strip() for l in out.splitlines() if l.strip()]

    def launch_safari(self):
        p = subprocess.run([OPEN, "-a", "Safari"], capture_output=True,
                           text=True, timeout=20)
        if p.returncode != 0:
            raise ProbeError("launch-failed", p.stderr.strip()[:200])

def wait_for(pred, timeout, reason):
    deadline = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > deadline:
            raise ProbeError(reason, "timed out")
        time.sleep(POLL)

def chrome_label(labels):
    for l in labels or []:
        if l.strip().lower().rstrip(".…").strip() in ("google chrome", "chrome"):
            return l.strip()
    return None

def note_block(path, reason):
    p = Path(path)
    line = f"- [ ] {TOOL}[{reason}]: {ACTIONS.get(reason, 'manual step needed')}."
    try:
        if p.exists() and f"{TOOL}[{reason}]" in p.read_text():
            return {"path": str(p), "appended": False, "deduplicated": True}
        with p.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        return {"path": str(p), "appended": True, "deduplicated": False}
    except OSError as e:
        return {"path": str(p), "appended": False, "deduplicated": False,
                "error": str(e)[:160]}

def base(mode):
    return {"schemaVersion": 1, "tool": TOOL, "mode": mode,
            "importConfirmed": False, "websitesSignedIn": False,
            "progress": [], "blocked": None}

def emitter(res):
    def emit(step, **kw):
        res["progress"].append({"step": step, **kw})
        print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                          "step": step, **kw}), file=sys.stderr)
    return emit

def host_info(ui):
    return {"platform": sys.platform, "safariInstalled": ui.safari_installed(),
            "chromeInstalled": ui.chrome_installed()}

def block(res, reason, needs_path, detail=None):
    res["blocked"] = {"reason": reason,
                      "detail": detail or ACTIONS.get(reason, reason)}
    res["needsMason"] = note_block(needs_path, reason)
    res["nextAction"] = "mason: " + ACTIONS.get(reason, "manual step needed")
    return res, 2

def status(ui):
    res = base("status")
    res["host"] = host_info(ui)
    if not ui.platform_supported():
        res["error"] = "unsupported-platform"
        return res, 1
    acc = {"ready": True}
    try:
        res["safari"] = {"running": ui.safari_running()}
        if res["safari"]["running"]:
            labels = ui.import_menu_labels()
            res["menu"] = {"importFromPresent": labels is not None,
                           "items": labels, "chromeItem": chrome_label(labels)}
            res["dialog"] = {"state": ui.import_dialog()}
            res["keychainPrompt"] = ui.keychain_prompt()
    except ProbeError as e:
        acc.update(ready=False, reason=e.reason, detail=e.detail)
    res["accessibility"], res["nextAction"] = acc, NEXT_STATUS
    return res, 0

def begin_import(ui, timeout, needs_path):
    res = base("begin-import")
    emit = emitter(res)
    res["host"] = host_info(ui)
    try:
        if not ui.platform_supported():
            res["error"] = "unsupported-platform"
            return res, 1
        if not ui.chrome_installed():
            return block(res, "chrome-not-installed", needs_path)
        res["safari"] = {"wasRunning": ui.safari_running(), "launched": False}
        if not res["safari"]["wasRunning"]:
            ui.launch_safari()
            emit("safari-launch")
            res["safari"]["launched"] = True
            wait_for(ui.safari_running, timeout, "launch-failed")
        sheet = ui.import_dialog()
        emit("dialog-check", state=sheet)
        if sheet == "import":
            res["dialog"] = {"alreadyOpen": True, "opened": False,
                             "titleMatched": True}
            res["nextAction"] = NEXT_DONE
            return res, 0
        if sheet == "other":
            return block(res, "confirmation-prompt", needs_path)
        if ui.keychain_prompt():
            return block(res, "keychain-prompt", needs_path)
        labels = ui.import_menu_labels()
        if labels is None:
            return block(res, "import-menu-missing", needs_path)
        emit("menu-labels", items=labels)
        label = chrome_label(labels)
        if not label:
            return block(res, "chrome-import-missing", needs_path,
                         "submenu items: " + ", ".join(labels))
        ui.click_import_item(label)
        emit("menu-click", item=label)
        res["menu"] = {"importFromPresent": True, "chromeItem": label}
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            sheet = ui.import_dialog()
            if sheet != "none":
                matched = sheet == "import"
                res["dialog"] = {"alreadyOpen": False, "opened": True,
                                 "titleMatched": matched}
                emit("dialog-opened", titleMatched=matched)
                res["nextAction"] = NEXT_DONE
                return res, 0
            if ui.keychain_prompt():
                return block(res, "keychain-prompt", needs_path)
            time.sleep(POLL)
        return block(res, "dialog-not-opened", needs_path)
    except ProbeError as e:
        return block(res, e.reason, needs_path, e.detail or None)

def main(argv=None, ui=None):
    p = argparse.ArgumentParser(
        prog="safari_import.py", epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Open Safari's built-in Chrome import dialog (status or "
                    "begin-import); secrets stay with macOS and the operator.")
    p.add_argument("mode", choices=["status", "begin-import"])
    p.add_argument("--needs-mason", default="NEEDS-MASON.md",
                   help="explicit path for the deduped handoff line")
    p.add_argument("--timeout", type=float, default=15.0,
                   help="seconds to wait for Safari/dialog (default 15)")
    args = p.parse_args(argv)
    if args.timeout <= 0:
        p.error("--timeout must be positive")
    ui = ui or SystemEvents()
    res, code = (status(ui) if args.mode == "status" else
                 begin_import(ui, args.timeout, args.needs_mason))
    print(json.dumps(res, indent=2, sort_keys=True))
    return code

if __name__ == "__main__":
    sys.exit(main())
