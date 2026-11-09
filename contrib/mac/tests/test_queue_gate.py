import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import queue_gate


def rows(count):
    return ''.join(f'RQ-{n}\tphantom\tdevin\tmid\t/prompt\n' for n in range(count))


class QueueGateTests(unittest.TestCase):
    def test_depths(self):
        for count, expected in [(0, 45), (10, 35), (45, 0), (100, 0)]:
            with self.subTest(count=count):
                self.assertEqual(queue_gate.allowance(18, rows(count), set())['allow'], expected)
        self.assertEqual(queue_gate.allowance(1, '', set())['target'], 8)

    def test_parked_and_retired(self):
        data = rows(2) + 'PARKED-DEP.devin\tRQ-X\tdevin\tmid\tphantom\t/prompt\n'
        data += 'RQ-Y\tphantom\tPARKED-DEP.devin\tmid\t/prompt\n'
        self.assertEqual(queue_gate.allowance(18, data, {'RQ-1'})['depth'], 1)

    def test_bad_input_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            q = Path(d)
            (q / 'admission.json').write_text(json.dumps({'cap': 'invalid'}))
            (q / 'router-queue.md').write_text('')
            (q / 'ready.tsv').write_text('bad row\n')
            p = subprocess.run([sys.executable, queue_gate.__file__, '--queue', d, '--json'], capture_output=True, text=True)
            self.assertEqual(p.returncode, 75)
            self.assertEqual(json.loads(p.stdout)['allow'], 0)
            (q / 'admission.json').write_text(json.dumps({'cap': 18}))
            (q / 'ready.tsv').write_text(rows(10))
            p = subprocess.run([sys.executable, queue_gate.__file__, '--queue', d, '--want', '9'], capture_output=True, text=True)
            self.assertEqual((p.returncode, p.stdout.strip()), (0, '9'))
            (q / 'admission.json').write_text('{}')
            self.assertEqual(queue_gate.read_gate(d)['allow'], 0)


if __name__ == '__main__': unittest.main()
