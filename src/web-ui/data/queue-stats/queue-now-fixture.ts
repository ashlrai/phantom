/** Snapshot of ci-efficiency/queue/queue-now.json (queue_now.v1, 2026-10-26 07:00 UTC), verbatim. */
export const QUEUE_NOW_FIXTURE = {
  "schema": "queue_now.v1",
  "generated_utc": "2026-10-26T07:00:40.825374+00:00",
  "window_h": 24.0,
  "repos": [
    "phantom",
    "phantom-secrets",
    "locus",
    "lexicon",
    "ashlr-md",
    "ashlr-stack",
    "ashlr-plugin"
  ],
  "stations": {
    "router_queued": {
      "status": "no data",
      "note": "no enter/exit events yet; needs RQ-QUEUE-1/2 emitters"
    },
    "claimed": {
      "status": "partial",
      "n_arrivals": 72,
      "lambda_per_h": 3.0,
      "note": "enter only (router-queue.md CLAIMED stamps); no exit stamps, so mu/L/W not computed"
    },
    "builder_run": {
      "status": "no data",
      "note": "no enter/exit events yet; needs RQ-QUEUE-1/2 emitters"
    },
    "publish": {
      "status": "no data",
      "note": "no enter/exit events yet; needs RQ-QUEUE-1/2 emitters"
    },
    "pr_open_rework": {
      "n_arrivals": 244,
      "n_done": 219,
      "lambda_per_h": 10.166666666666666,
      "mu_per_h": 0.029683306901109065,
      "c": null,
      "rho": null,
      "L": 45.4930513234954,
      "W_h": 33.68896879756469,
      "WIP": 66,
      "little_err_pct": 652.8721555146248,
      "c_source": "infinite-server (each PR its own server); rho n/a"
    },
    "pr_ci": {
      "n_arrivals": 719,
      "n_done": 669,
      "lambda_per_h": 29.958333333333332,
      "mu_per_h": 8.90009016865974,
      "c": null,
      "rho": null,
      "L": 3.5156396840277817,
      "W_h": 0.11235841222388307,
      "WIP": 53,
      "little_err_pct": 4.2543870038826235,
      "c_source": "GitHub runner concurrency per org not exposed via gh; rho omitted"
    },
    "review": {
      "status": "no data",
      "note": "no enter/exit events yet; needs RQ-QUEUE-1/2 emitters"
    },
    "merge_group": {
      "n_arrivals": 5,
      "n_done": 3,
      "lambda_per_h": 0.20833333333333334,
      "mu_per_h": 5.224963715529753,
      "c": 5,
      "rho": 0.007974537037037039,
      "L": 0.045412624398148145,
      "W_h": 0.19138888888888891,
      "WIP": 2,
      "little_err_pct": 12.19911706575774,
      "c_source": "c=5 merge queue max build (per brief; ruleset not re-read)"
    },
    "release": {
      "n_arrivals": 3,
      "n_done": 3,
      "lambda_per_h": 0.125,
      "mu_per_h": 16.19190404797601,
      "c": 1,
      "rho": 0.007719907407407409,
      "L": 0.007719907407407408,
      "W_h": 0.061759259259259264,
      "WIP": 0,
      "little_err_pct": 0.0,
      "c_source": "c=1 ASSUMED (one release at a time per repo), unverified"
    },
    "live": {
      "status": "no data",
      "note": "no enter/exit events yet; needs RQ-QUEUE-1/2 emitters"
    },
    "fix_main": {
      "status": "no data",
      "note": "no enter/exit events yet; needs RQ-QUEUE-1/2 emitters"
    }
  },
  "bottleneck": {
    "max_rho": "merge_group",
    "max_rho_value": 0.007974537037037039,
    "max_W_share": "pr_open_rework",
    "W_share_pct": {
      "pr_open_rework": 92.7,
      "pr_ci": 7.2,
      "merge_group": 0.1,
      "release": 0.0
    }
  }
} as const;
