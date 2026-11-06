import json
import tempfile
import unittest
from pathlib import Path
from memory_admission import required_memory_bytes


class AdmissionMemoryTests(unittest.TestCase):
    def test_missing_history_preserves_fallback(self):
        self.assertEqual(required_memory_bytes('/missing/jobs.jsonl', 'pool', 100), 100)

    def test_matching_pool_peaks_include_swap_and_never_reduce_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'jobs.jsonl'
            rows = [
                {'schemaVersion': 1, 'pool': 'pool', 'memory': {
                    'schemaVersion': 1, 'sampleCount': 2, 'peakRssBytes': 200, 'peakSwapBytes': 30}},
                {'schemaVersion': 1, 'pool': 'other', 'memory': {
                    'schemaVersion': 1, 'sampleCount': 2, 'peakRssBytes': 999, 'peakSwapBytes': 99}},
                {'schemaVersion': 1, 'pool': 'pool', 'memory': {
                    'schemaVersion': 1, 'sampleCount': 2, 'peakRssBytes': 210, 'peakSwapBytes': None}},
                {'schemaVersion': 1, 'pool': 'pool', 'memory': {
                    'schemaVersion': 1, 'sampleCount': 2, 'peakRssBytes': float('inf'), 'peakSwapBytes': 0}},
                {'schemaVersion': 1, 'pool': 'pool', 'memory': {
                    'schemaVersion': 1, 'sampleCount': 2, 'peakRssBytes': 10 ** 1000, 'peakSwapBytes': 0}},
                {'schemaVersion': 1, 'pool': 'pool', 'memory': {
                    'schemaVersion': 1, 'sampleCount': 2, 'peakRssBytes': 1e308, 'peakSwapBytes': 1e308}},
                {}, None,
            ]
            path.write_text('\n'.join(json.dumps(row) for row in rows) + '\n{broken\n')
            self.assertEqual(required_memory_bytes(path, 'pool', 100), 230)
            self.assertEqual(required_memory_bytes(path, 'pool', 300), 300)

    def test_invalid_fallback_refused(self):
        with self.assertRaises(ValueError):
            required_memory_bytes('/missing/jobs.jsonl', 'pool', -1)


if __name__ == '__main__':
    unittest.main()
