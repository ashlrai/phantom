import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pool_bridge_evidence as bridge


class BridgeEvidenceTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.home = Path(scratch.name).resolve()
        self.binary = self.put("binary", b"fixture", 0o700)
        self.put("devin/credentials.toml", b"opaque fixture")
        self.now = bridge.clock() + 500
        self.calls = []

    def put(self, name, value, mode=0o600):
        path = self.home / name
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.write_bytes(value if isinstance(value, bytes) else json.dumps(value).encode())
        path.chmod(mode)
        return path

    def devin(self, model="swe-2-flash-max", listing=None, after="fixture-user", cap=(1, 4), mutate=False):
        if listing is None:
            listing = "Available models (1 family)\nSWE (swe)\n  swe-2-flash-max  Flash [262K context, Free]"
        def run(binary, args, env):
            self.assertEqual(binary, self.binary)
            self.assertEqual(env["XDG_DATA_HOME"], str(self.home))
            self.calls.append(args)
            if args == ("models", "list"):
                if mutate:
                    self.put("devin/credentials.toml", b"changed fixture")
                return listing
            account = "fixture-user" if len(self.calls) == 1 else after
            return f"Logged in\nUser ID: {account}\nAPI server: https://api.devin.ai\nDevin API: https://devin.ai"
        return bridge.devin_evidence(self.binary, self.home, self.home, model, cap, run=run, now=lambda: self.now)

    def test_devin_exact_free_bound_to_principal_and_separate_cap(self):
        record = self.devin()
        self.assertEqual(self.calls, [("auth", "status"), ("models", "list"), ("auth", "status")])
        self.assertEqual(record["executableSha256"], hashlib.sha256(b"fixture").hexdigest())
        identity = b'["devin-native-principal-v1",["https://api.devin.ai","https://devin.ai"],"user-id","fixture-user"]'
        self.assertEqual(record["accountDigest"], hashlib.sha256(identity).hexdigest())
        self.assertEqual(record["expiresAt"] - record["observedAt"], bridge.MAX_AGE)
        self.assertEqual(record["quota"], {"kind": "unknown"})
        self.assertEqual(record["reservationCap"], {"maxConcurrent": 1, "maxPerHour": 4})
        self.assertNotIn("fixture-user", json.dumps(record))

    def test_devin_swe_21_only_if_exactly_listed_free(self):
        model = "swe-2.1-max"
        head = "Available models (1 family)\nSWE (swe)\n"
        row = "  swe-2.1-max  SWE [262K context, Free]"
        for listing in (None, head + row.replace("Free", "$1 / 1M Input"), head + row + "\n" + row,
                        head + row.replace("max", "max-preview"), head + row.replace("Free", "Free, $1 / 1M Input")):
            with self.subTest(listing=listing), self.assertRaisesRegex(bridge.Held, "devin-free-unverified"):
                self.calls = []
                self.devin(model, listing)
        self.calls = []
        self.assertEqual(self.devin(model, head + row)["model"], model)

    def test_devin_refuses_account_drift_credential_drift_and_missing_cap(self):
        for options, reason in (({"after": "changed"}, "devin-free-unverified"),
                                ({"cap": (None, 4)}, "devin-reservation-cap-invalid"),
                                ({"mutate": True}, "devin-free-unverified")):
            with self.subTest(options=options), self.assertRaisesRegex(bridge.Held, reason):
                self.calls = []
                self.devin(**options)

    def plan_inputs(self, lane="zai"):
        synthetic_key = b"test-key-material"
        self.put(".zai-lane/api_key", synthetic_key + b"\n")
        launcher = Path(bridge.__file__).parent / "host-integration/launch.candidate.sh"
        pin = hashlib.sha256(synthetic_key).hexdigest()[:32]
        a = {"accountDigest": pin if lane == "zai" else "a" * 64, "attestedAt": self.now - 1000,
             "attestationExpiresAt": self.now + 100_000}
        a.update({"plan": "zai-glm-coding-lite", "autoRecharge": False} if lane == "zai" else {
            "plan": "google-ai-ultra-personal", "useG1Credits": False})
        q = {"lanes": {lane: {"used_frac": 0.42, "reset_at": (self.now + 200_000) / 1000}}}
        args = (lane, "glm-5.3" if lane == "zai" else "gemini-4-neon-low", self.home, self.binary,
                launcher, self.put("attestation.json", a), self.put("queue/resources.json", q))
        return args, a, q

    def test_zai_matches_checkout_key_boundary_and_emits_only_metadata(self):
        args, a, _ = self.plan_inputs()
        record = bridge.plan_evidence(*args, now=lambda: self.now)
        self.assertEqual(record["accountDigest"], a["accountDigest"])
        self.assertEqual(record["quota"]["usedPercent"], 42)
        self.assertEqual(record["billing"]["kind"], "owner-attested-plan")
        self.assertEqual(record["expiresAt"], a["attestationExpiresAt"])
        self.assertNotIn("test-key-material", json.dumps(record))

    def test_zai_accepts_live_launcher_review_digest(self):
        args, a, _ = self.plan_inputs()
        live = Path(bridge.__file__).parent / "host-integration/launch.sh"
        record = bridge.plan_evidence(*args[:4], live, *args[5:], now=lambda: self.now)
        self.assertEqual(record["accountDigest"], a["accountDigest"])

    def test_zai_wrong_fingerprint_unknown_boundary_and_invalid_attestations(self):
        args, attestation, _ = self.plan_inputs()
        for change in ({"accountDigest": "a" * 32}, {"autoRecharge": True},
                       {"attestationExpiresAt": self.now}, {"plan": "metered"}):
            with self.subTest(change=change), self.assertRaises(bridge.Held):
                self.put("attestation.json", attestation | change)
                bridge.plan_evidence(*args, now=lambda: self.now)
        self.put("attestation.json", attestation)
        with self.assertRaisesRegex(bridge.Held, "zai-key-boundary-unverified"):
            bridge.plan_evidence(*args[:4], self.binary, *args[5:], now=lambda: self.now)
        args[5].unlink()
        with self.assertRaises(FileNotFoundError):
            bridge.plan_evidence(*args, now=lambda: self.now)

    def test_zai_missing_invalid_or_stale_usage_and_past_reset(self):
        args, _, doc = self.plan_inputs()
        for row in ({}, {"used_frac": -1, "reset_at": 1}, {"used_frac": 0.3, "reset_at": self.now / 1000}):
            with self.subTest(row=row), self.assertRaisesRegex(bridge.Held, "quota-unverified"):
                self.put("queue/resources.json", {"zai": row})
                bridge.plan_evidence(*args, now=lambda: self.now)
        file = self.put("queue/resources.json", doc)
        stale = (self.now - bridge.MAX_AGE - 1000) / 1000
        os.utime(file, (stale, stale))
        with self.assertRaisesRegex(bridge.Held, "quota-unverified"):
            bridge.plan_evidence(*args, now=lambda: self.now)
        file.unlink()
        with self.assertRaises(FileNotFoundError):
            bridge.plan_evidence(*args, now=lambda: self.now)

    def test_agy_does_not_claim_a_pinned_identity(self):
        args, attestation, _ = self.plan_inputs("agy")
        with self.assertRaisesRegex(bridge.Held, "agy-identity-unverified"):
            bridge.plan_evidence(*args, now=lambda: self.now)
        self.put("attestation.json", attestation | {"useG1Credits": True})
        with self.assertRaisesRegex(bridge.Held, "owner-attestation-unverified"):
            bridge.plan_evidence(*args, now=lambda: self.now)

    def test_cli_removes_old_evidence_on_hold_without_printing_input(self):
        output = self.put("bridge-evidence/seat.json", {"old": True})
        status = bridge.main(["zai", "--model", "glm-5.3", "--home", str(self.home), "--output", str(output)])
        self.assertEqual(status, 1)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
