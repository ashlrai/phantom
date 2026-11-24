import json, os, random, sys, tempfile, unittest
sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from cruise import sensors, sensors_macos, sensors_linux, controller, shed, watchdog, markers, profiles, runner, metrics
from cruise.sensors import Sample, Proc

FIX = os.path.join(HERE, "fixtures")


def fake_runner(table):
    def run(argv, timeout):
        return table.get(" ".join(argv))
    return run


MAC_TABLE = {
    "/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level": "1\n",
    "/usr/sbin/sysctl -n kern.memorystatus_level": "73\n",
    "/usr/sbin/sysctl -n vm.swapusage": "total = 89088.00M  used = 87952.25M  free = 1135.75M  (encrypted)\n",
    "/usr/sbin/sysctl -n hw.ncpu": "18\n",
    "/usr/sbin/sysctl -n hw.memsize": "137438953472\n",
    "/usr/sbin/sysctl -n vm.loadavg": "{ 15.26 25.14 46.09 }\n",
    "/usr/sbin/sysctl -n hw.model": "Mac15,9\n",
    "/usr/bin/pmset -g therm": "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\n",
    "/bin/ps -axo pid=,ppid=,pgid=,uid=,rss=,pcpu=,stat=,comm=":
        "  368     1   368     0 23646624 100.0 Rs   /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/FSEvents.framework/Versions/A/Support/fseventsd\n"
        "77579 87055 87055   501 3482832   0.0 S    /Applications/Devin.app/Contents/MacOS/Devin Helper (Plugin)\n",
}
MAC_TABLE["/usr/bin/vm_stat"] = open(os.path.join(FIX, "vm_stat.txt")).read()


class TestMacSensor(unittest.TestCase):
    def test_sample(self):
        s = sensors_macos.MacOSSensor(fake_runner(MAC_TABLE), clock=lambda: 1000.0).sample()
        self.assertEqual(s.pressure_level, "normal")
        self.assertEqual(s.free_pct, 73.0); self.assertEqual(s.pressure_score, 27.0)
        self.assertEqual(s.swap_used_bytes, int(87952.25 * (1 << 20)))
        self.assertEqual(s.swapouts_total, 14002729)
        self.assertEqual(s.compressed_bytes, 1624563 * 16384)
        self.assertAlmostEqual(s.load_per_core, 15.26 / 18)
        self.assertEqual(s.thermal, "nominal")
        self.assertEqual(s.errors, [])

    def test_ps_no_argv_and_spaces(self):
        rows = sensors_macos.MacOSSensor(fake_runner(MAC_TABLE)).processes()
        self.assertEqual(rows[0].name, "fseventsd"); self.assertEqual(rows[0].rss_bytes, 23646624 * 1024)
        self.assertEqual(rows[1].name, "Devin Helper (Plugin)")

    def test_unknowns_never_raise(self):
        s = sensors_macos.MacOSSensor(fake_runner({})).sample()
        self.assertIsNone(s.pressure_level); self.assertIsNone(s.compressed_bytes); self.assertIsNone(s.thermal)

    def test_thermal_bands(self):
        self.assertEqual(sensors_macos.parse_pmset_therm("CPU_Speed_Limit = 60"), "serious")
        self.assertEqual(sensors_macos.parse_pmset_therm("CPU_Speed_Limit = 100"), "nominal")
        self.assertIsNone(sensors_macos.parse_pmset_therm("garbage"))


class TestLinuxSensor(unittest.TestCase):
    def test_fixture_tree(self):
        d = tempfile.mkdtemp()
        os.makedirs(d + "/proc/pressure"); os.makedirs(d + "/sys/class/thermal/thermal_zone0")
        open(d + "/proc/meminfo", "w").write("MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB\nZswap: 8 kB\n")
        open(d + "/proc/pressure/memory", "w").write("some avg10=12.50 avg60=1 avg300=0 total=1\nfull avg10=0.00 avg60=0 avg300=0 total=0\n")
        open(d + "/proc/vmstat", "w").write("pswpin 1\npswpout 77\n")
        open(d + "/proc/loadavg", "w").write("4.00 3 2 1/2 3\n")
        z = d + "/sys/class/thermal/thermal_zone0"
        open(z + "/temp", "w").write("91000\n"); open(z + "/trip_point_0_type", "w").write("passive\n"); open(z + "/trip_point_0_temp", "w").write("90000\n")
        s = sensors_linux.LinuxSensor(); s.root = d
        smp = s.sample()
        self.assertEqual(smp.pressure_score, 12.5); self.assertEqual(smp.pressure_level, "normal"); self.assertEqual(smp.free_pct, 25.0)
        self.assertEqual(smp.swap_used_bytes, 60 * 1024); self.assertEqual(smp.swapouts_total, 77)
        self.assertEqual(smp.compressed_bytes, 8 * 1024); self.assertEqual(smp.thermal, "serious")


class SimNode:
    """Synthetic node with a memory knee at K sessions: below K indicators are flat noise, above K
    compressed memory and pressure climb with every extra session."""
    def __init__(self, K, seed=1):
        self.K, self.r, self.t, self.comp, self.swap, self.so = K, random.Random(seed), 0.0, 10 << 30, 0, 0

    def sample(self, n):
        self.t += 60
        over = max(0, n - self.K)
        self.comp += int(over * (400 << 20) + self.r.uniform(-1, 1) * (20 << 20))
        self.swap += int(over * (200 << 20))
        self.so += over * 5000 + self.r.randint(0, 50)
        return Sample(ts=self.t, os="sim", mem_total_bytes=64 << 30, ncpu=16, pressure_level="critical" if over > 6 else "normal",
                      pressure_score=25 + self.r.uniform(-1, 1) + over * 6, free_pct=75 - over * 6, swap_used_bytes=self.swap,
                      swapouts_total=self.so, compressed_bytes=self.comp, load_per_core=0.05 * n + self.r.uniform(0, 0.05), thermal="nominal")


def drive(ctl, node, ticks, demand=100, start=1):
    n, log = start, []
    for _ in range(ticks):
        d = ctl.step(node.sample(n), n, demand, [{"job": "j%d" % i, "lane": "x", "started_ts": i, "value": 0.5} for i in range(n)])
        if d["shed"]: n -= 1                 # exactly one session leaves per shed decision
        elif d["target"] > n: n = d["target"]  # dispatchd fills to target
        log.append((n, d))
    return n, log


class TestController(unittest.TestCase):
    def test_ramps_and_holds_below_knee(self):
        ctl = controller.Controller(None, {"knee": 4.0, "step": 1.0})
        n, log = drive(ctl, SimNode(K=12), 240)
        tail = [x[0] for x in log[-60:]]
        self.assertGreaterEqual(min(tail), 8, tail); self.assertLessEqual(max(tail), 14, tail)
        self.assertGreater(ctl.p["knee"].value, 4.0)   # the knee was learned upward from the prior

    def test_sheds_one_at_a_time(self):
        ctl = controller.Controller(None, {"knee": 30.0})
        node = SimNode(K=5)
        n, log = drive(ctl, node, 30, start=20)
        sheds = [d for _n, d in log if d["shed"]]
        self.assertTrue(sheds)
        for d in sheds: self.assertIsInstance(d["shed"], dict)   # one victim per decision, never a list
        steps = [log[i][0] - log[i + 1][0] for i in range(len(log) - 1)]
        self.assertLessEqual(max(steps), 1)

    def test_foreign_pressure_not_blamed_on_fleet(self):
        def run(share):
            ctl = controller.Controller(None, {"knee": 30.0}); node = SimNode(K=5)
            acts = []
            for _ in range(20):
                d = ctl.step(node.sample(20), 20, 50, [{"job": "j", "lane": "x", "started_ts": 1, "value": 0.5}],
                             fleet={"cpu_share": share, "mem_share": share})
                acts.append(d["action"])
            return acts
        foreign = run(0.03)
        self.assertNotIn("shed", foreign); self.assertIn("hold_foreign", foreign)
        self.assertIn("shed", run(0.9))

    def test_foreign_warn_keeps_knee(self):
        ctl = controller.Controller(None, {"knee": 22.0})
        s = Sample(ts=60.0, mem_total_bytes=128 << 30, pressure_level="normal", pressure_score=38, load_per_core=3.1)
        d = ctl.step(s, 2, 90, [], fleet={"cpu_share": 0.0, "mem_share": 0.0})
        self.assertEqual(d["zone"], "warn"); self.assertEqual(d["knee"], 22.0)

    def test_unknown_holds(self):
        ctl = controller.Controller()
        d = ctl.step(Sample(ts=1.0), 5, 10, [])
        self.assertEqual(d["zone"], "unknown"); self.assertLessEqual(d["target"], 5)

    def test_no_raise_without_demand(self):
        ctl = controller.Controller(None, {"knee": 20.0}); node = SimNode(K=50)
        for _ in range(20): d = ctl.step(node.sample(3), 3, 0, [])
        self.assertLessEqual(d["target"], 3)

    def test_missed_bad_event_tightens_thresholds(self):
        ctl = controller.Controller(None, {"knee": 20.0}); node = SimNode(K=50)
        for _ in range(10): ctl.step(node.sample(3), 3, 10, [])
        zw = ctl.p["z_warn"].value
        ctl.step(node.sample(3), 3, 10, [], bad_event=True)
        self.assertLess(ctl.p["z_warn"].value, zw)

    def test_state_roundtrip(self):
        ctl = controller.Controller(); node = SimNode(K=8)
        drive(ctl, node, 20)
        st = json.loads(json.dumps(ctl.state()))
        c2 = controller.Controller(st)
        self.assertEqual(c2.target, ctl.target); self.assertEqual(c2.p["knee"].value, ctl.p["knee"].value)


class TestShed(unittest.TestCase):
    def test_lowest_value_then_newest(self):
        s = [{"job": "a", "value": 0.9, "started_ts": 10}, {"job": "b", "value": 0.1, "started_ts": 5}, {"job": "c", "value": 0.1, "started_ts": 8}]
        self.assertEqual(shed.pick_victim(s)["job"], "c")
        self.assertIsNone(shed.pick_victim([]))


class TestWatchdog(unittest.TestCase):
    def test_fseventsd_flagged_alert_only(self):
        w = watchdog.Watchdog(); alerts = []
        for i in range(5):
            p = [Proc(368, 1, 368, 0, (22 << 30) + i * (100 << 20), 100.0, "Rs", "fseventsd")]
            alerts += w.scan_daemons(p, 60.0 * i, own_pgids=(), mem_total=128 << 30, uid_self=501)
        self.assertEqual(len(alerts), 1)            # cooldown: one alert, not one per tick
        self.assertEqual(alerts[0]["action"], "alert_only"); self.assertTrue(alerts[0]["system"])

    def test_small_shells_do_not_alert(self):
        w = watchdog.Watchdog(); alerts = []
        for i in range(40):
            procs = [Proc(100 + j, 1, 100 + j, 501, (5 << 20) + j * 1000, 0.0, "S", "zsh") for j in range(50)]
            procs.append(Proc(999, 1, 999, 501, 40 << 20 if i > 35 else 5 << 20, 0.0, "S", "zsh"))
            alerts += w.scan_daemons(procs, 60.0 * i, uid_self=501, mem_total=128 << 30)
        self.assertEqual(alerts, [])

    def test_own_groups_not_daemons(self):
        w = watchdog.Watchdog()
        for i in range(5):
            a = w.scan_daemons([Proc(9, 1, 9, 501, 30 << 30, 100.0, "S", "fseventsd")], 60.0 * i, own_pgids={9})
            self.assertEqual(a, [])

    def test_rss_cap_learned_then_sustained(self):
        w = watchdog.Watchdog()
        for i in range(30):
            w.job_caps({"j": {"lane": "codex", "pgid": 7}}, [Proc(7, 1, 7, 501, 1 << 30, 1.0, "S", "node")], i, 64 << 30, 40)
        plans = []
        for i in range(5):
            _c, plan = w.job_caps({"j": {"lane": "codex", "pgid": 7}}, [Proc(7, 1, 7, 501, 20 << 30, 1.0, "S", "node")], 100 + i, 64 << 30, 40)
            plans.append(plan)
        self.assertEqual(plans[0], []); self.assertTrue(plans[-1])

    def test_zombies(self):
        z = watchdog.Watchdog.zombies([Proc(5, 4, 4, 501, 0, 0, "Z", "x"), Proc(4, 1, 4, 501, 1, 0, "S", "p")], {4})
        self.assertEqual(z, [{"pid": 5, "ppid": 4, "ours": True, "name": "x"}])


class TestMarkers(unittest.TestCase):
    def test_only_ignored_dirs(self):
        c = tempfile.mkdtemp(); wt = os.path.join(c, "RQ-1")
        os.makedirs(wt + "/node_modules"); os.makedirs(wt + "/dist"); os.makedirs(wt + "/src")
        os.makedirs(wt + "/packages/a/node_modules")
        open(wt + "/.gitignore", "w").write("node_modules/\n")
        items = markers.plan(c)
        paths = sorted(os.path.relpath(p, c) for p, _ in items)
        self.assertEqual(paths, [".metadata_never_index", "RQ-1/node_modules/.metadata_never_index", "RQ-1/packages/a/node_modules/.metadata_never_index"])
        self.assertEqual(markers.apply(items), 3); self.assertEqual(markers.plan(c), [])

    def test_git_container_refused(self):
        c = tempfile.mkdtemp(); os.makedirs(c + "/.git")
        self.assertEqual(markers.plan(c), [])


class TestProfiles(unittest.TestCase):
    def test_classes(self):
        self.assertEqual(profiles.classify(8 << 30, "MacBookPro17,1"), "mac-8gb")
        self.assertEqual(profiles.classify(16 << 30, "MacBookAir10,1"), "mac-16gb-fanless")
        self.assertEqual(profiles.classify(128 << 30, "Mac15,9"), "mac-large")
        self.assertEqual(profiles.priors_for(32 << 30, None, "linux")["profile"], "generic")


class FakeSensor(sensors.OSSensor):
    def __init__(self, s, procs): self.s, self.p = s, procs
    def sample(self): return self.s
    def processes(self): return self.p


class TestRunner(unittest.TestCase):
    def home(self, kill=False, pause=""):
        h = tempfile.mkdtemp(); R = h + "/.ashlr-runs"
        os.makedirs(R + "/queue/run"); os.makedirs(R + "/metrics"); os.makedirs(h + "/.ashlr")
        json.dump({"last_tick": "x", "lanes": {"claude": {"running": 1, "target": 4, "queued": 3}, "devin": {"running": 1, "target": 6, "held": True, "queued": 1}}},
                  open(R + "/queue/status.json", "w"))
        open(R + "/queue/run/RQ-A.pgid", "w").write("4242 Mon Nov 24 01:00:00 2026\n")
        open(R + "/queue/run/RQ-A.line", "w").write("RQ-A\tphantom\tclaude\tmid\n")
        open(R + "/metrics/jobs.jsonl", "w").write('{"event":"launch","job":"RQ-A","lane":"claude","ts":"2026-11-24T01:00:00-0500"}\n')
        if kill: open(h + "/.ashlr/KILL", "w").write("x")
        if pause: open(R + "/PAUSE", "w").write(pause)
        open(R + "/CRUISE_RSS_APPLY", "w").write("")
        return runner.Paths(h)

    def test_shadow_tick_writes_side_by_side(self):
        P = self.home(pause="2026-11-24 02:34:14 swap_backstop=85G")
        s = Sample(ts=1000.0, os="macos", mem_total_bytes=128 << 30, ncpu=18, pressure_level="normal", pressure_score=27, load_per_core=0.8,
                   swap_used_bytes=1, compressed_bytes=1, swapouts_total=1, thermal="nominal")
        rec = runner.tick(P, FakeSensor(s, [Proc(4242, 1, 4242, 501, 1 << 30, 5.0, "S", "claude")]), now=1000.0)
        self.assertEqual(rec["dispatchd"]["running_total"], 2); self.assertEqual(rec["dispatchd"]["target_total"], 4)
        self.assertEqual(rec["registry_live"], 1); self.assertFalse(rec["bad_event"])
        self.assertTrue(os.path.exists(P.R + "/metrics/cruise-shadow.jsonl"))
        d = json.load(open(P.Q + "/cruise-decision.json")); self.assertEqual(d["mode"], "shadow")
        self.assertTrue(os.path.exists(P.R + "/PAUSE"))          # PAUSE is never touched

    def test_kill_disables_apply(self):
        P = self.home(kill=True)
        s = Sample(ts=1000.0, os="macos", mem_total_bytes=128 << 30)
        rec = runner.tick(P, FakeSensor(s, []), now=1000.0)
        self.assertTrue(rec["kill"]); self.assertFalse(rec["rss_apply"])

    def test_dynamic_pause_is_bad_event(self):
        P = self.home(pause="2026-11-24 02:34:14 swap_growth=4000/min")
        s = Sample(ts=1000.0, os="macos", mem_total_bytes=128 << 30)
        self.assertTrue(runner.tick(P, FakeSensor(s, []), now=1000.0)["bad_event"])
        self.assertFalse(runner.tick(P, FakeSensor(s, []), now=1060.0)["bad_event"])   # same pause, not a new event


class TestCapacity(unittest.TestCase):
    def test_foreign_daemon_not_charged_to_fleet(self):
        from cruise import capacity
        procs = [Proc(368, 1, 368, 0, 22 << 30, 239.0, "R", "fseventsd")] + [Proc(1000 + i, 1, 1000 + i, 501, 1 << 30, 20.0, "S", "node") for i in range(4)]
        sp = capacity.split(procs, {1000, 1001, 1002, 1003})
        self.assertAlmostEqual(sp["foreign_cpu_cores"], 2.39); self.assertLess(sp["cpu_share"], 0.3)
        hr = capacity.headroom_slots(sp, 4, 128 << 30, 73.0, 18, 75.0, 2.0)
        self.assertGreater(hr["host_slots"], 4)     # the old rule (all load charged to 4 sessions) would give ~0 headroom


class TestHeartbeat(unittest.TestCase):
    def test_payload(self):
        from cruise import heartbeat
        sen = sensors_macos.MacOSSensor(fake_runner(dict(MAC_TABLE, **{"/bin/launchctl list": "PID\tStatus\tLabel\n123\t0\tai.ashlr.memguard\n-\t78\tai.ashlr.node-worker\n"})))
        hb = heartbeat.build(sen, {}, 1000.0)
        self.assertEqual(hb["os"]["family"], "macos"); self.assertEqual(hb["memory"]["total_bytes"], 137438953472)
        labels = [r["label"] for r in hb["services"]]
        self.assertIn("ai.ashlr.memguard", labels)
        d = tempfile.mkdtemp(); p = heartbeat.write(hb, d); self.assertTrue(os.path.exists(p))


class TestBaseline(unittest.TestCase):
    def test_counts(self):
        h = tempfile.mkdtemp(); R = h + "/.ashlr-runs"; os.makedirs(R + "/metrics")
        import time as _t
        now = _t.mktime(_t.strptime("2026-11-24 02:00:00", "%Y-%m-%d %H:%M:%S"))
        iso = lambda s: _t.strftime("%Y-%m-%dT%H:%M:%S%z", _t.localtime(now - s))
        open(R + "/metrics/load-curve.jsonl", "w").write("".join('{"ts":"%s","running_total":%d}\n' % (iso(60 * i), 4) for i in range(10)))
        open(R + "/metrics/jobs.jsonl", "w").write('{"event":"outcome","state":"MERGED","url":"u1","ts":"%s"}\n{"event":"outcome","state":"MERGED","url":"u1","ts":"%s"}\n' % (iso(100), iso(50)))
        mg = lambda s, r: "%s reaped=0 pause=[%s] pause_local=[]\n" % (_t.strftime("%Y-%m-%d %H:%M:%S", _t.localtime(now - s)), r)
        open(R + "/memguard.log", "w").write(mg(600, "swap_growth=2000/min") + mg(540, "swap_growth=2000/min") + mg(480, "") + mg(120, "mem_free=20%"))
        b = metrics.baseline(runner.Paths(h), [24], now=now)["windows"]["24h"]
        self.assertEqual(b["merges"], 1); self.assertEqual(b["pause_episodes"], 2); self.assertEqual(b["sessions"]["median"], 4)


if __name__ == "__main__":
    unittest.main()
