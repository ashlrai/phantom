import unittest
from unittest.mock import Mock
from claude_recovery import Result, classify, recover


class ClaudeRecoveryTest(unittest.TestCase):
    def run_recovery(self, results, **kwargs):
        dispatch = Mock(side_effect=results)
        gate = kwargs.pop('precheck', Mock(return_value=Result(0)))
        route = kwargs.pop('reroute', Mock(return_value=True))
        sleep = Mock()
        outcome = recover(gate, dispatch, reroute=route, sleep=sleep, **kwargs)
        return outcome, dispatch, route, sleep

    def test_recovery(self):
        outcome, dispatch, route, sleep = self.run_recovery([
            Result(1, transient=True), Result(1, transient=True), Result(0)])
        self.assertEqual((outcome.state, outcome.attempts), ('completed', 3))
        self.assertEqual(sleep.call_args_list, [((1,),), ((2,),)])
        self.assertEqual(dispatch.call_count, 3)
        route.assert_not_called()

    def test_exhaustion_retains_job(self):
        outcome, dispatch, route, sleep = self.run_recovery([Result(1, transient=True)] * 3)
        self.assertEqual((outcome.state, outcome.reason), ('held', 'transient'))
        self.assertEqual(dispatch.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        route.assert_not_called()

    def test_exhaustion_reroutes_eligible_job_once(self):
        outcome, _, route, _ = self.run_recovery([Result(1, transient=True)] * 3, eligible=True)
        self.assertEqual(outcome.state, 'rerouted')
        route.assert_called_once_with()

    def test_empty_exit_one_is_not_success_or_blind_retry(self):
        outcome, dispatch, _, sleep = self.run_recovery([Result(1, empty=True)], eligible=True)
        self.assertEqual((outcome.state, outcome.reason), ('rerouted', 'empty-exit-1'))
        dispatch.assert_called_once_with()
        sleep.assert_not_called()

    def test_unacknowledged_reroute_retains_job(self):
        outcome, _, _, _ = self.run_recovery([Result(1, empty=True)], eligible=True,
                                            reroute=Mock(return_value=False))
        self.assertEqual(outcome.state, 'held')

    def test_precheck_holds_never_launch_or_reroute(self):
        for code in (2, 10, 11, 12, 13):
            with self.subTest(code=code):
                outcome, dispatch, route, _ = self.run_recovery([], eligible=True,
                                                               precheck=Mock(return_value=Result(code)))
                self.assertEqual((outcome.state, outcome.attempts), ('held', 0))
                dispatch.assert_not_called()
                route.assert_not_called()

    def test_precheck_rechecked_after_backoff(self):
        outcome, dispatch, route, _ = self.run_recovery([Result(1, transient=True)], eligible=True,
            precheck=Mock(side_effect=[Result(0), Result(13)]))
        self.assertEqual((outcome.state, outcome.attempts), ('held', 1))
        dispatch.assert_called_once_with()
        route.assert_not_called()

    def test_deterministic_failures_never_retry_or_reroute(self):
        for result in (Result(1), Result(2), Result(0, empty=True)):
            outcome, dispatch, route, sleep = self.run_recovery([result], eligible=True)
            self.assertEqual(outcome.state, 'held')
            dispatch.assert_called_once_with()
            route.assert_not_called()
            sleep.assert_not_called()

    def test_uncertain_handoff_propagates(self):
        with self.assertRaises(RuntimeError):
            self.run_recovery([Result(1, empty=True)], eligible=True,
                              reroute=Mock(side_effect=RuntimeError('handoff unavailable')))

    def test_exit_one_empty_classification_precedes_transient(self):
        self.assertEqual(classify(Result(1, empty=True, transient=True)), 'empty-exit-1')


if __name__ == '__main__':
    unittest.main()
