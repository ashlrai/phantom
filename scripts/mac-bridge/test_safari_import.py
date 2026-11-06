"""Hermetic tests for safari_import.py: all UI/system calls go through a fake
adapter; no live browser, System Events, keychain or profile access occurs."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import safari_import as si

class FakeUI:
    """Test adapter: records every call; never touches a real app or file."""

    DEFAULTS = dict(platform_ok=True, safari_app=True, chrome_app=True,
                    running=True, labels=["Google Chrome…", "Mozilla Firefox…"],
                    sheet="none", after_click="import", keychain=False,
                    probe_error=None)

    def __init__(self, **kw):
        self.__dict__.update({**self.DEFAULTS, **kw})
        self.calls, self._clicked = [], False

    def _probe(self, name, value):
        self.calls.append(name)
        if self.probe_error and name in ("labels", "dialog", "click"):
            raise si.ProbeError(self.probe_error, "denied")
        return value

    def platform_supported(self):
        self.calls.append("platform"); return self.platform_ok

    def safari_installed(self):
        self.calls.append("safari-app"); return self.safari_app

    def chrome_installed(self):
        self.calls.append("chrome-app"); return self.chrome_app

    def safari_running(self):
        self.calls.append("running"); return self.running

    def launch_safari(self):
        self.calls.append("launch"); self.running = True

    def import_menu_labels(self):
        return self._probe("labels", self.labels)

    def keychain_prompt(self):
        self.calls.append("keychain"); return self.keychain

    def import_dialog(self):
        sheet = self.after_click if self._clicked else self.sheet
        return self._probe("dialog", sheet)

    def click_import_item(self, label):
        self.calls.append(("click", label))
        self._clicked = True
        self._probe("click", None)

def run(argv, ui):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = si.main(argv, ui=ui)
    return code, json.loads(out.getvalue())

class SafariImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.note = str(Path(self.tmp.name) / "NEEDS-MASON.md")
        self.argv = ["begin-import", "--needs-mason", self.note,
                     "--timeout", "0.2"]

    def tearDown(self):
        self.tmp.cleanup()

    def note_lines(self):
        p = Path(self.note)
        return p.read_text().splitlines() if p.exists() else []

    def test_begin_import_reaches_import_menu_and_opens_dialog(self):
        ui = FakeUI(running=False)
        code, res = run(self.argv, ui)
        self.assertEqual(code, 0)
        self.assertIn("launch", ui.calls)
        self.assertIn(("click", "Google Chrome…"), ui.calls)
        self.assertEqual(res["menu"]["chromeItem"], "Google Chrome…")
        self.assertTrue(res["dialog"]["opened"])
        self.assertFalse(res["importConfirmed"])
        self.assertFalse(res["websitesSignedIn"])
        self.assertIsNone(res["blocked"])
        self.assertFalse(Path(self.note).exists())

    def test_missing_chrome_or_import_option_is_explicit(self):
        cases = [(dict(chrome_app=False), "chrome-not-installed", None),
                 (dict(labels=["Mozilla Firefox…"]), "chrome-import-missing",
                  "Mozilla Firefox"),
                 (dict(labels=None), "import-menu-missing", None)]
        for kw, reason, detail in cases:
            code, res = run(self.argv, FakeUI(**kw))
            self.assertEqual(code, 2)
            self.assertEqual(res["blocked"]["reason"], reason)
            if detail:
                self.assertIn(detail, res["blocked"]["detail"])
            self.assertTrue(Path(self.note).exists())
            Path(self.note).unlink()

    def test_blocks_write_one_deduped_line_each(self):
        cases = [(dict(probe_error="accessibility"), "accessibility"),
                 (dict(sheet="none", keychain=True), "keychain-prompt")]
        for kw, reason in cases:
            for _ in range(2):  # repeated runs must not duplicate the line
                code, res = run(self.argv, FakeUI(**kw))
                self.assertEqual(code, 2)
                self.assertEqual(res["blocked"]["reason"], reason)
        lines = self.note_lines()
        self.assertEqual(len(lines), 2)
        for kw, reason in cases:
            match = [l for l in lines if f"safari-import[{reason}]" in l]
            self.assertEqual(len(match), 1)

    def test_existing_sheet_state_is_respected(self):
        ui = FakeUI(sheet="import")  # repeated run: never reopen an active dialog
        code, res = run(self.argv, ui)
        self.assertEqual(code, 0)
        self.assertTrue(res["dialog"]["alreadyOpen"])
        self.assertFalse(res["dialog"]["opened"])
        self.assertNotIn(("click", "Google Chrome…"), ui.calls)
        ui = FakeUI(sheet="other")  # unrelated sheet blocks before any click
        code, res = run(self.argv, ui)
        self.assertEqual(code, 2)
        self.assertEqual(res["blocked"]["reason"], "confirmation-prompt")
        self.assertNotIn(("click", "Google Chrome…"), ui.calls)

    def test_non_darwin_refuses_without_ui_calls(self):
        ui = FakeUI(platform_ok=False)
        code, res = run(self.argv, ui)
        self.assertEqual(code, 1)
        self.assertEqual(res["error"], "unsupported-platform")
        self.assertNotIn("labels", ui.calls)

    def test_status_reports_truthfully(self):
        code, res = run(["status", "--needs-mason", self.note], FakeUI())
        self.assertEqual(code, 0)
        self.assertTrue(res["safari"]["running"])
        self.assertEqual(res["menu"]["chromeItem"], "Google Chrome…")
        self.assertEqual(res["dialog"]["state"], "none")
        self.assertFalse(res["importConfirmed"])
        self.assertFalse(res["websitesSignedIn"])

    def test_help_names_second_mac_icloud_keychain_step(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit) as cm:
                si.main(["--help"], ui=FakeUI())
        self.assertEqual(cm.exception.code, 0)
        self.assertIn("iCloud Keychain", out.getvalue())
        self.assertIn("begin-import", out.getvalue())

    def test_source_has_no_secret_or_profile_access(self):
        src = Path(si.__file__).read_text()
        for banned in ("value of ", "Login Data", "binarycookies",
                       "defaults read", "sqlite3", "shell=True",
                       "security find", "security dump", "Keychains",
                       "Library/Safari", "Library/Google", "keychain:"):
            self.assertNotIn(banned, src)
        # Only the osascript and open wrappers may spawn processes.
        self.assertEqual(src.count("subprocess.run"), 2)

if __name__ == "__main__":
    unittest.main()
