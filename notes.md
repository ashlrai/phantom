# Findings
The router feed and RQ-METRICS-IMPACT-SCORE modules are absent from this checkout.
Use an explicit local feed stub and accept snapshots through stdin. Do not invent
impact weights: consume versioned shared-score receipts and withhold impact
ranking when receipts or token observations are incomplete.
The current user explicitly forbids publishing, committing and pushing, overriding
the queue's publish.sh handoff instruction.
