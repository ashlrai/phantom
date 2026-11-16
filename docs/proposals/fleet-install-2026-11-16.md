# Fleet install review

Live fleet status unknown for 41 modules; bundle at docs/proposals/fleet-install-2026-11-16.md

Merged snapshot: refs/remotes/origin/master at c506ace9db0ff51a900dfdec852b9488616fc4ce (local; not fetched).
Live bin: ~/.ashlr-runs/bin. Security must review and pin before installation. Diffs are scrubbed review text, not installable patches.
Tests run for this implementation: 470/470 affected-suite checks passed; final focused rerun 5/5 passed. Backend/web typecheck, changed-file ESLint and docs check passed. Full lint: 9 existing errors / 269 warnings; verify-changed: 9 passed / 1 existing authority-closure failure. These checks do not validate live dispatcher behavior.
Rollback: Security retains prior files and matching pins together; restore that reviewed pair and verify hashes before resuming. This command never installs or rolls back.
Gap: PR-level fix attribution and installed runtime acceptance are unknown. Counts refer to files, not PRs.
Live counterpart inventory unknown; only declared modules are listed.
sandbox-pins.tsv unknown (missing, unreadable or invalid).
41 modules have unknown source, live bytes, pins or diffs.

Source, live hash, pin and diff unknown: dispatchd_guard.py, metrics-outcomes.sh, precheck.sh, reap-one.sh, restock.sh, router_queue.py, router.py, scrub.pl.

| File | Source | State | Source sha256 | Live sha256 | Pin sha256 | Pin state |
| --- | --- | --- | --- | --- | --- | --- |
| arm_gate.py | contrib/mac/arm_gate.py | unknown | 48620266fbf02392cbf811770ef83b2165ece65031eed174edb980ca587ff28e | unknown | unknown | unknown |
| batch_sessions.py | contrib/mac/batch_sessions.py | unknown | 0f194add4031810a42f375681ef082f19037b91f736b2ff9fda65f062c2b5972 | unknown | unknown | unknown |
| batch-launch.sh | contrib/mac/batch-launch.sh | unknown | c49e7ede0204540a95f6f3db117538c4de5ac54e7fa3f62f8001452d530d4f8b | unknown | unknown | unknown |
| batch-sessions.json | contrib/mac/batch-sessions.json | unknown | 62d0a1bf1a2efbe8cf6c6869fc2b32e56052a8f2481cf08bf7a995db5057ee3c | unknown | unknown | unknown |
| batcher.py | contrib/mac/batcher.py | unknown | ce21f110a0484926c0375ca4c59f3254531a3808d21f9e6ef5da81070c35803e | unknown | unknown | unknown |
| branch-gardener.py | contrib/mac/branch-gardener.py | unknown | d04655fca202dfd4e1b7d9d4e54f3f6b088bb2ccf6035c203836e7b1a528635c | unknown | unknown | unknown |
| concurrency.py | contrib/mac/concurrency.py | unknown | f6c1cf6df52313e1f5282c1530d31f790f1fec497c1c1ba8fb9e4aea44c37932 | unknown | unknown | unknown |
| dispatchd.py | contrib/mac/dispatchd.py | unknown | 04ce257e49cd53c75663b3490486557e7ebb263ff0eb6b60f85d9922d5fc55cf | unknown | unknown | unknown |
| fleet_controller.py | contrib/mac/fleet_controller.py | unknown | 7f08200fabcde4c2039367b7db36718c82810a22deb2ca801ba7fec9d41a4767 | unknown | unknown | unknown |
| host_pressure_admission.py | contrib/mac/host_pressure_admission.py | unknown | 6b2e87df1253fbf501a31553562293e26862871b30d9823a5c87a4fe3ed15e80 | unknown | unknown | unknown |
| host_session_disk_cache.py | contrib/mac/host_session_disk_cache.py | unknown | 766ffcf8a6ab408f8d3e6b368c1883029aa9b5a0ba814abbd1d0e511e5862613 | unknown | unknown | unknown |
| host_session_observation.py | contrib/mac/host_session_observation.py | unknown | dfee0279acfa7f20bc93ce743c4afcc6581fb3f42f0cf62675c41a9513ef40de | unknown | unknown | unknown |
| host_session_runtime.py | contrib/mac/host_session_runtime.py | unknown | a02feea46787575e9447802167fcd864f9aa49bf631e661d6454fe68222c94db | unknown | unknown | unknown |
| host_session_tick.py | contrib/mac/host_session_tick.py | unknown | 44cae806a7ddf5e7c8a7ecf1dc9c6e8a99450dd1bbb8e6982c553951ba9d070b | unknown | unknown | unknown |
| install-gate.py | contrib/mac/install-gate.py | unknown | dce0a3878f174a028b3140b68f1ae6bd9bb849a1d5c48799872b77a3017162f4 | unknown | unknown | unknown |
| integrated-merge.py | contrib/mac/integrated-merge.py | unknown | 804929cb30a12555b809fbfcfa8e8133bfc23a8fdcd67341c4cbc1c14de818c2 | unknown | unknown | unknown |
| judge_gate.py | contrib/mac/judge_gate.py | unknown | 8d901cf409b0f7b1611b23b84953f3a2c421bdf7b9bd6a8ff3bb85315651a97d | unknown | unknown | unknown |
| launch_precheck.py | contrib/mac/launch_precheck.py | unknown | 74c563d0e6f9405c18141500bb2572d649007298e25be4197f7866febe693dc1 | unknown | unknown | unknown |
| launch-gate.sh | contrib/mac/launch-gate.sh | unknown | 0c6ae04d208615ed936808ac37a2fb6e927a522921439d18cf704d33b63815f0 | unknown | unknown | unknown |
| launch.sh | contrib/mac/host-integration/launch.candidate.sh | unknown | 4167335dac896d6de7f8d04d960dc658978c3d37e604fea54109461c996d9919 | unknown | unknown | unknown |
| local_job.py | contrib/mac/local_job.py | unknown | e78bdf9530fbfa354e5df7e2d942230a7208ead4cdbcf333b596764763e75b57 | unknown | unknown | unknown |
| mason-inbox-append | contrib/mac/mason-inbox-append | unknown | 3d2cadab49c144889b44b6bd2597b32a4351751c6bf94a74c5b3e1f6dd598164 | unknown | unknown | unknown |
| postrun_pr.py | contrib/mac/postrun_pr.py | unknown | c1b44c02b0044e04e22971ea994f48b7de508ff03a9877b0d52759af8168b0a9 | unknown | unknown | unknown |
| process_snapshot.py | contrib/mac/process_snapshot.py | unknown | 0147ef9bd61cdf7a5d9f97a8969f72ce158da88fb140b329e9b06ae7381ec8b4 | unknown | unknown | unknown |
| publish.sh | contrib/mac/publish.sh | unknown | 4980543f16541b572e81ba35b3f845126ef9a6700d8a702eeb0dd312dc49eddc | unknown | unknown | unknown |
| release-autorun.sh | contrib/mac/release-autorun.sh | unknown | 45099b5aa569cefd0041e180b2a49d4cf7401c85303dd0e3ed42350d31061502 | unknown | unknown | unknown |
| restock.py | contrib/mac/restock.py | unknown | 235c886fe9acf3e1b541236d007ba31ca172017aafd1b9a90d904e0b90c89668 | unknown | unknown | unknown |
| session_handoff.py | contrib/mac/session_handoff.py | unknown | 809b677580e0861cbee532c2f98aa15940fa370bd37719507b5c70cdfaa3342f | unknown | unknown | unknown |
| staged_drain.py | contrib/mac/staged_drain.py | unknown | 28780cb2247eeffd480afc4d8163091b9e95c045e91166a34c8bb1f3f9ec7001 | unknown | unknown | unknown |
| staged-drain.sh | contrib/mac/staged-drain.sh | unknown | ba057983df733c2d08af2e790cd86f7a486990c51e44137d392158a6c87ce24e | unknown | unknown | unknown |
| work_market.py | contrib/mac/work_market.py | unknown | 2abb267efa6f9056c140587c9206d46ab09b638f88add0a6d50abc08af55a662 | unknown | unknown | unknown |
| wt-prune.py | contrib/mac/wt-prune.py | unknown | b51487a68755ece0e6966542960c6e67d2786a22d9217554682b558543deb733 | unknown | unknown | unknown |
| wt-prune.sh | contrib/mac/wt-prune.sh | unknown | ec75e9358cc869fb0b6add52eeae6b69f960697dad4945e341363784c092df1f | unknown | unknown | unknown |

## Diffs
Hashes compare original bytes; empty review diffs may reflect redaction. Null diffs are unknown.
