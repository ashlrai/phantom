"""Tests for the staged dispatchd reader. Run: python3 -m unittest test_node_capacity (from this directory)."""
import json
import os
import tempfile
import time
import unittest

import node_capacity as nc

HERE = os.path.dirname(os.path.abspath(__file__))
RECORDED = os.path.join(HERE, "..", "..", "test", "fixtures", "node-autoscale", "main-mbp-2026-11-16.json")


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(ts))


class ReaderTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "node-capacity.json")
        with open(RECORDED) as f:
            self.doc = json.load(f)
        self.now = time.time()
        self.doc["measured_at"] = iso(self.now - 10)

    def write(self, doc):
        with open(self.path, "w") as f:
            json.dump(doc, f)

    def test_recorded_document_caps_cloud_lanes_by_their_own_runnable(self):
        self.write(self.doc)
        doc = nc.read_doc(self.path, now=self.now)
        self.assertIsNotNone(doc)
        grok = self.doc["agents_runnable_now"]["grok"]
        self.assertEqual(nc.lane_capacity_cap("grok", 1, doc), 1 + grok)
        self.assertEqual(nc.lane_capacity_cap("codex-personal", 9, doc), 9 + self.doc["agents_runnable_now"]["codex"])

    def test_unknown_lane_or_unmeasured_harness_keeps_memguard(self):
        self.write(self.doc)
        doc = nc.read_doc(self.path, now=self.now)
        self.assertIsNone(nc.lane_capacity_cap("zai", 0, doc))
        self.assertIsNone(nc.lane_capacity_cap("cursor", 1, doc))  # never measured on this node
        self.assertIsNone(nc.lane_capacity_cap("grok", -1, doc))

    def test_gates_and_staleness_fall_back(self):
        doc = dict(self.doc, basis=dict(self.doc["basis"], limiting={k: "pressure" for k in self.doc["basis"]["limiting"]}))
        self.write(doc)
        self.assertIsNone(nc.lane_capacity_cap("grok", 1, nc.read_doc(self.path, now=self.now)))
        self.write(dict(self.doc, measured_at=iso(self.now - 600)))
        self.assertIsNone(nc.read_doc(self.path, now=self.now))
        self.write(dict(self.doc, schema="other"))
        self.assertIsNone(nc.read_doc(self.path, now=self.now))
        with open(self.path, "w") as f:
            f.write("{not json")
        self.assertIsNone(nc.read_doc(self.path, now=self.now))

    def test_symlink_is_refused(self):
        real = os.path.join(self.dir, "real.json")
        with open(real, "w") as f:
            json.dump(self.doc, f)
        os.symlink(real, self.path)
        self.assertIsNone(nc.read_doc(self.path, now=self.now))


if __name__ == "__main__":
    unittest.main()
